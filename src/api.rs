//! HTTP API used by the browser UI.

use crate::levels::{Book, Kind, Level, World};
use crate::progress::{Completion, Progress, RANKS, Settings, today};
use crate::runner;
use crate::teacher::{self, Mode};
use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{Value, json};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tokio_stream::StreamExt;
use tokio_stream::wrappers::ReceiverStream;

pub const REVIEW_BONUS_XP: u32 = 15;
const EFFORTS: &[&str] = &["low", "medium", "high", "xhigh", "max"];

pub struct AppState {
    /// Where progress and scratch files live (`save/`, or `FERRIS_SAVE_DIR`).
    pub save_dir: PathBuf,
    pub worlds: Vec<World>,
    pub book: Book,
    pub progress: Mutex<Progress>,
    pub usage: Arc<Mutex<Option<Value>>>,
    /// Set when the last save failed (shown in the game), cleared when a save works again.
    pub save_error: Mutex<Option<String>>,
    /// A one-time message from startup, e.g. that a damaged save was backed up.
    pub notice: Mutex<Option<String>>,
    /// The compiler's version ("1.99.0"), shown on the sign on the title screen.
    pub rustc: Option<String>,
}

type Shared = Arc<AppState>;

impl AppState {
    fn save_path(&self) -> PathBuf {
        self.save_dir.join("progress.json")
    }
    fn work_dir(&self) -> PathBuf {
        self.save_dir.join("tmp")
    }
    fn ferris_dir(&self) -> PathBuf {
        self.save_dir.join("ferris")
    }
    /// Save, remembering the error for the HUD. Callers that must not carry on when the
    /// disk write failed use `try_save` instead and react to the error.
    fn save(&self, progress: &Progress) {
        let _ = self.try_save(progress);
    }

    /// Save and hand the error back to the caller (also recorded for the HUD).
    fn try_save(&self, progress: &Progress) -> Result<(), String> {
        let result = progress.save(&self.save_path());
        if let Err(e) = &result {
            eprintln!("⚠ Saving failed: {e}");
        }
        *self.save_error.lock().unwrap() = result.as_ref().err().cloned();
        result
    }
    fn level(&self, id: &str) -> Result<(&World, usize, &Level), ApiError> {
        World::find(&self.worlds, id)
            .ok_or(ApiError(StatusCode::NOT_FOUND, format!("no level {id}")))
    }

    /// Find a level the player is allowed to play right now.
    fn playable(&self, id: &str) -> Result<(&World, usize, &Level), ApiError> {
        let (world, li, level) = self.level(id)?;
        let wi = self
            .worlds
            .iter()
            .position(|w| w.id == world.id)
            .unwrap_or(0);
        let p = self.progress.lock().unwrap();
        if !self.level_unlocked(&p, wi, li) && !p.is_done(id) {
            return Err(ApiError(
                StatusCode::FORBIDDEN,
                "That level is still locked.".into(),
            ));
        }
        Ok((world, li, level))
    }

    fn world_unlocked(&self, p: &Progress, idx: usize) -> bool {
        idx == 0
            || self.worlds[idx - 1]
                .levels
                .last()
                .is_some_and(|l| p.has_reached(&l.id))
    }

    fn level_unlocked(&self, p: &Progress, world_idx: usize, level_idx: usize) -> bool {
        self.world_unlocked(p, world_idx)
            && (level_idx == 0 || p.has_reached(&self.worlds[world_idx].levels[level_idx - 1].id))
    }

    /// The first unfinished level that is open to play.
    fn next_level(&self, p: &Progress) -> Option<String> {
        for (wi, w) in self.worlds.iter().enumerate() {
            for (li, l) in w.levels.iter().enumerate() {
                if !p.is_done(&l.id) && self.level_unlocked(p, wi, li) {
                    return Some(l.id.clone());
                }
            }
        }
        None
    }

    fn level_after(&self, id: &str) -> Option<String> {
        let all: Vec<&Level> = self.worlds.iter().flat_map(|w| &w.levels).collect();
        let i = all.iter().position(|l| l.id == id)?;
        all.get(i + 1).map(|l| l.id.clone())
    }

    /// Bonus XP for idiomatic code, once per finished level.
    fn award_review_bonus(&self, level_id: &str) -> bool {
        let mut p = self.progress.lock().unwrap();
        if !p.completed.contains_key(level_id) || !p.review_bonus.insert(level_id.to_string()) {
            return false;
        }
        p.xp += REVIEW_BONUS_XP;
        if let Some(c) = p.completed.get_mut(level_id) {
            c.xp += REVIEW_BONUS_XP;
        }
        self.save(&p);
        true
    }

    fn player(&self, p: &Progress) -> Value {
        let (rank, next) = p.rank();
        let total: usize = self.worlds.iter().map(|w| w.levels.len()).sum();
        json!({
            "name": p.name,
            "xp": p.xp,
            "rank": rank,
            "next_rank": next.map(|(xp, name)| json!({"xp": xp, "name": name})),
            "ranks": RANKS.iter().map(|(xp, name)| json!({"xp": xp, "name": name})).collect::<Vec<_>>(),
            "streak": p.streak(),
            "days": p.days_played.len(),
            "completed": p.completed.len(),
            "total_levels": total,
            "save_error": *self.save_error.lock().unwrap(),
        })
    }

    /// Save the submitted code as this level's draft and record which attempt the run
    /// belongs to (`Progress::generation`). Both happen under one lock, so a replay can't
    /// slip in between the draft and the number it is paired with.
    ///
    /// If the draft can't be written, nothing is compiled: the caller gets a diagnosable
    /// error instead of a result the player could mistake for a graded attempt. The
    /// in-memory draft is rolled back too, so it never claims a save that didn't happen.
    fn begin_run(&self, id: &str, code: &str) -> Result<u64, ApiError> {
        let mut p = self.progress.lock().unwrap();
        let previous = p.drafts.insert(id.to_string(), code.to_string());
        if let Err(e) = self.try_save(&p) {
            match previous {
                Some(old) => {
                    p.drafts.insert(id.to_string(), old);
                }
                None => {
                    p.drafts.remove(id);
                }
            }
            return Err(ApiError(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Couldn't save your code, so it wasn't run: {e}"),
            ));
        }
        Ok(p.generation(id))
    }

    /// Record a finished run. A run whose attempt has since been replayed away is stale:
    /// the response says so (`stale: true`) and nothing — completion, XP, attempts,
    /// replays — changes, because the result belongs to an attempt that no longer exists.
    /// Any other run is graded normally, with XP only for the first clear.
    fn finish_run(
        &self,
        world: &World,
        li: usize,
        level: &Level,
        id: &str,
        generation: u64,
        result: &runner::RunResult,
    ) -> Value {
        let mut p = self.progress.lock().unwrap();
        // Compare the exact attempt number this run started in, not just "did the counter
        // change": two replays during one compile move 0 -> 2, and a run from either
        // attempt 0 or attempt 1 is equally stale.
        if p.is_stale(id, generation) {
            return json!({
                "result": result, "xp_gained": 0, "first_clear": false, "world_cleared": false,
                "stale": true, "player": self.player(&p), "next_id": self.level_after(id),
            });
        }
        p.days_played.insert(today());
        p.record_errors(id, &result.error_codes);
        let first_clear = result.passed && !p.completed.contains_key(id);
        let mut xp_gained = 0;
        if !p.completed.contains_key(id) {
            *p.attempts.entry(id.to_string()).or_default() += 1;
        }
        if first_clear {
            xp_gained = p.xp_for(id, level.xp);
            p.xp += xp_gained;
            let completion = Completion {
                xp: xp_gained,
                hints_used: p.hint_tier.get(id).copied().unwrap_or(0),
                attempts: p.attempts.get(id).copied().unwrap_or(1),
            };
            p.completed.insert(id.to_string(), completion);
            p.skipped.remove(id);
            p.reached.insert(id.to_string());
        }
        let world_cleared = first_clear && li + 1 == world.levels.len();
        self.save(&p);
        json!({
            "result": result, "xp_gained": xp_gained, "first_clear": first_clear,
            "world_cleared": world_cleared, "player": self.player(&p), "next_id": self.level_after(id),
        })
    }
}

/// A request failure with an HTTP status and a message the page can show.
#[derive(Debug)]
pub struct ApiError(StatusCode, String);

/// The longest code the game accepts to save or run (far more than any level needs).
const MAX_CODE_BYTES: usize = 200_000;

fn check_code_size(code: &str) -> Result<(), ApiError> {
    if code.len() > MAX_CODE_BYTES {
        return Err(ApiError(
            StatusCode::PAYLOAD_TOO_LARGE,
            format!(
                "That's more than {} KB of code. Please keep it shorter.",
                MAX_CODE_BYTES / 1000
            ),
        ));
    }
    Ok(())
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(json!({ "error": self.1 }))).into_response()
    }
}

pub fn router(state: Shared) -> Router {
    Router::new()
        .route("/api/state", get(get_state))
        .route("/api/level/{id}", get(get_level))
        .route("/api/lesson/{id}", get(get_lesson))
        .route("/api/run", post(run_level))
        .route("/api/play", post(play))
        .route("/api/quiz", post(quiz))
        .route("/api/skip", post(skip))
        .route("/api/replay", post(replay))
        .route("/api/draft", post(save_draft))
        .route("/api/name", post(set_name))
        .route("/api/settings", post(set_settings))
        .route("/api/models", get(models))
        .route("/api/models/test", post(test_model))
        .route("/api/models/refresh", post(refresh_models))
        .route("/api/explain/{code}", get(explain))
        .route("/api/ferris", post(ferris))
        .route("/api/vim", get(crate::nvim::vim_ws))
        .with_state(state)
}

async fn get_state(State(s): State<Shared>) -> Json<Value> {
    let p = s.progress.lock().unwrap();
    let worlds: Vec<Value> = s
        .worlds
        .iter()
        .enumerate()
        .map(|(wi, w)| {
            let levels: Vec<Value> = w
                .levels
                .iter()
                .enumerate()
                .map(|(li, l)| {
                    let status = if p.completed.contains_key(&l.id) {
                        "done"
                    } else if p.skipped.contains(&l.id) {
                        "skipped"
                    } else if s.level_unlocked(&p, wi, li) {
                        "open"
                    } else {
                        "locked"
                    };
                    json!({
                        "id": l.id, "num": format!("{}.{}", w.id, li + 1),
                        "title": l.title, "kind": l.kind, "xp": l.xp, "status": status,
                        "earned": p.completed.get(&l.id).map(|c| c.xp),
                    })
                })
                .collect();
            let done = w.levels.iter().filter(|l| p.is_done(&l.id)).count();
            let planned: Vec<Value> = w
                .planned
                .iter()
                .map(|pl| json!({"title": pl.title, "kind": pl.kind, "about": pl.about, "book": s.book.labels(&pl.book)}))
                .collect();
            json!({
                "id": w.id, "name": w.name, "blurb": w.blurb, "tag": w.tag,
                "available": !w.levels.is_empty(),
                "unlocked": !w.levels.is_empty() && s.world_unlocked(&p, wi),
                "done": done, "levels": levels, "planned": planned,
                "chapters": world_chapters(&s.book, w),
            })
        })
        .collect();
    let codex: Vec<Value> = p
        .codex
        .iter()
        .map(|(code, e)| json!({"code": code, "count": e.count, "first_level": e.first_level}))
        .collect();
    Json(json!({
        "player": s.player(&p),
        "rustc": s.rustc,
        "settings": p.settings,
        "usage": *s.usage.lock().unwrap(),
        "worlds": worlds,
        "codex": codex,
        "next_level": s.next_level(&p),
        "notice": s.notice.lock().unwrap().take(),
    }))
}

/// The book chapters a world covers, e.g. ["Ch 4: Understanding Ownership"].
fn world_chapters(book: &Book, w: &World) -> Vec<String> {
    let mut chapters: Vec<String> = Vec::new();
    let ids = w
        .levels
        .iter()
        .flat_map(|l| &l.book)
        .chain(w.planned.iter().flat_map(|p| &p.book));
    for id in ids {
        let chapter = id.split('.').next().unwrap_or(id);
        let label = match book.get(chapter) {
            Some(s) if chapter.chars().all(|c| c.is_ascii_digit()) => {
                format!("Ch {chapter}: {}", s.title)
            }
            _ => "Appendices".to_string(),
        };
        if !chapters.contains(&label) {
            chapters.push(label);
        }
    }
    chapters
}

/// Book links for a level: id, title and URL of each section it teaches.
fn book_links(book: &Book, ids: &[String]) -> Vec<Value> {
    ids.iter()
        .filter_map(|id| book.get(id))
        .map(|sec| json!({"id": sec.id, "title": sec.title, "url": book.url(sec)}))
        .collect()
}

async fn get_level(
    State(s): State<Shared>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let (world, li, level) = s.playable(&id)?;
    let p = s.progress.lock().unwrap();
    let done = p.completed.contains_key(&id);
    Ok(Json(json!({
        "id": level.id, "num": format!("{}.{}", world.id, li + 1),
        "title": level.title, "kind": level.kind, "goal": level.goal,
        "stdin": level.stdin, "args": level.args, "env": level.env, "files": level.files.keys().collect::<Vec<_>>(),
        "lesson": level.lesson, "c_compare": level.c_compare, "py_compare": level.py_compare,
        "starter": level.starter,
        "code": p.drafts.get(&id).cloned().unwrap_or_else(|| level.starter.clone()),
        "check": level.check, "expected_output": level.expected_output, "tests": level.tests,
        "choices": level.choices, "xp": level.xp,
        "hint_count": level.hints.len().max(3), "hint_tier": p.hint_tier.get(&id).copied().unwrap_or(0),
        "done": done, "skipped": p.skipped.contains(&id),
        "explanation": if done { level.explanation.clone() } else { String::new() },
        "world": {"id": world.id, "name": world.name},
        "index": li + 1, "count": world.levels.len(),
        "next_id": s.level_after(&id),
        "book": book_links(&s.book, &level.book),
    })))
}

/// The reading material for any level, even a locked one: no code, tests or answers.
async fn get_lesson(
    State(s): State<Shared>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let (world, li, level) = s.level(&id)?;
    Ok(Json(json!({
        "id": level.id, "num": format!("{}.{}", world.id, li + 1),
        "title": level.title, "kind": level.kind, "goal": level.goal,
        "lesson": level.lesson, "c_compare": level.c_compare, "py_compare": level.py_compare,
        "book": book_links(&s.book, &level.book),
    })))
}

#[derive(Deserialize)]
struct CodeReq {
    id: String,
    code: String,
}

async fn run_level(
    State(s): State<Shared>,
    Json(req): Json<CodeReq>,
) -> Result<Json<Value>, ApiError> {
    check_code_size(&req.code)?;
    let (world, li, level) = s.playable(&req.id)?;
    if matches!(level.kind, Kind::Predict | Kind::Quiz) {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "Predict and quiz levels are answered, not run.".into(),
        ));
    }
    // Save the submitted code *before* compiling. Edits the player makes while it compiles
    // are autosaved afterwards and must win, so the result below never touches the draft.
    // If that save fails, stop here: a result from code that was never stored is worse
    // than an error the player can see.
    let generation = s.begin_run(&req.id, &req.code)?;
    let result = runner::check_level(level, &req.code, &s.work_dir()).await;
    Ok(Json(s.finish_run(
        world, li, level, &req.id, generation, &result,
    )))
}

#[derive(Deserialize)]
struct PlayReq {
    code: String,
    /// For a level's "Run it" button: give the program that level's input and files.
    #[serde(default)]
    id: Option<String>,
}

async fn play(State(s): State<Shared>, Json(req): Json<PlayReq>) -> Result<Json<Value>, ApiError> {
    check_code_size(&req.code)?;
    let setup = req
        .id
        .as_deref()
        .and_then(|id| s.level(id).ok())
        .map(|(_, _, l)| runner::Setup::from_level(l))
        .unwrap_or_default();
    Ok(Json(json!(
        runner::play(&req.code, &setup, &s.work_dir()).await
    )))
}

#[derive(Deserialize)]
struct QuizReq {
    id: String,
    choice: usize,
}

async fn quiz(State(s): State<Shared>, Json(req): Json<QuizReq>) -> Result<Json<Value>, ApiError> {
    let (world, li, level) = s.playable(&req.id)?;
    let correct = level.answer == Some(req.choice);
    let mut p = s.progress.lock().unwrap();
    p.days_played.insert(today());
    let mut xp_gained = 0;
    let first_clear = correct && !p.completed.contains_key(&req.id);
    if first_clear {
        let wrong = p.wrong_guesses.get(&req.id).copied().unwrap_or(0);
        let base = if wrong == 0 { level.xp } else { level.xp / 2 };
        xp_gained = p.xp_for(&req.id, base);
        p.xp += xp_gained;
        let completion = Completion {
            xp: xp_gained,
            hints_used: p.hint_tier.get(&req.id).copied().unwrap_or(0),
            attempts: wrong + 1,
        };
        p.completed.insert(req.id.clone(), completion);
        p.skipped.remove(&req.id);
        p.reached.insert(req.id.clone());
    } else if !correct && !p.completed.contains_key(&req.id) {
        *p.wrong_guesses.entry(req.id.clone()).or_default() += 1;
        *p.attempts.entry(req.id.clone()).or_default() += 1;
    }
    s.save(&p);
    Ok(Json(json!({
        "correct": correct,
        "explanation": if correct { level.explanation.clone() } else { String::new() },
        "xp_gained": xp_gained, "first_clear": first_clear,
        "world_cleared": first_clear && li + 1 == world.levels.len(),
        "player": s.player(&p), "next_id": s.level_after(&req.id),
    })))
}

#[derive(Deserialize)]
struct IdReq {
    id: String,
}

async fn skip(State(s): State<Shared>, Json(req): Json<IdReq>) -> Result<Json<Value>, ApiError> {
    let (_, _, level) = s.playable(&req.id)?;
    if level.kind == Kind::Boss {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "Bosses can't be skipped — you've got this!".into(),
        ));
    }
    let mut p = s.progress.lock().unwrap();
    if !p.completed.contains_key(&req.id) {
        p.skipped.insert(req.id.clone());
        p.reached.insert(req.id.clone());
    }
    s.save(&p);
    Ok(Json(json!({ "next_id": s.level_after(&req.id) })))
}

/// Play a level again from scratch (its XP is taken back and can be earned again).
async fn replay(State(s): State<Shared>, Json(req): Json<IdReq>) -> Result<Json<Value>, ApiError> {
    s.playable(&req.id)?;
    let mut p = s.progress.lock().unwrap();
    // The replay is one save: XP taken back, completion removed and the attempt number
    // bumped together. If the write fails, the whole change is undone, so the player
    // can't lose XP for an attempt that was never reset (and never see "reset" in a
    // UI that then reloads the old progress).
    let before = p.clone();
    let xp_returned = p.replay(&req.id);
    if let Err(e) = s.try_save(&p) {
        *p = before;
        return Err(ApiError(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Couldn't save, so level {} wasn't reset: {e}", req.id),
        ));
    }
    Ok(Json(
        json!({ "xp_returned": xp_returned, "player": s.player(&p) }),
    ))
}

/// Autosave. Fails loudly (500) when the save file can't be written, so the page can say so.
async fn save_draft(
    State(s): State<Shared>,
    Json(req): Json<CodeReq>,
) -> Result<StatusCode, ApiError> {
    // Only real levels get drafts, so the save file can't grow without bound.
    s.level(&req.id)?;
    check_code_size(&req.code)?;
    let mut p = s.progress.lock().unwrap();
    let previous = p.drafts.insert(req.id.clone(), req.code);
    match s.try_save(&p) {
        Ok(()) => Ok(StatusCode::NO_CONTENT),
        Err(e) => {
            // Don't keep a draft in memory that the save file never got: the page still
            // holds the edit and will send it again.
            match previous {
                Some(old) => {
                    p.drafts.insert(req.id, old);
                }
                None => {
                    p.drafts.remove(&req.id);
                }
            }
            Err(ApiError(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Couldn't save: {e}"),
            ))
        }
    }
}

#[derive(Deserialize)]
struct NameReq {
    name: String,
}

async fn set_name(State(s): State<Shared>, Json(req): Json<NameReq>) -> StatusCode {
    let mut p = s.progress.lock().unwrap();
    p.name = req.name.trim().chars().take(24).collect();
    s.save(&p);
    StatusCode::NO_CONTENT
}

async fn set_settings(
    State(s): State<Shared>,
    Json(new): Json<Settings>,
) -> Result<Json<Settings>, ApiError> {
    if !EFFORTS.contains(&new.effort.as_str()) {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "unknown effort level".into(),
        ));
    }
    if !["claude_code", "offline"].contains(&new.teacher.as_str()) {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "unknown teacher mode".into(),
        ));
    }
    let model = new.model.trim();
    if model.is_empty()
        || model.len() > 80
        || !model
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "-_.[]".contains(c))
    {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "that doesn't look like a model name".into(),
        ));
    }
    let mut p = s.progress.lock().unwrap();
    p.settings = Settings {
        model: model.to_string(),
        ..new
    };
    s.save(&p);
    Ok(Json(p.settings.clone()))
}

/// The model cards. Each card is a Claude Code alias, which always means the newest model
/// in that family. The fallback name is only shown until Claude Code has told us which
/// model the alias really is (after a reply, a test, or "Check for new versions").
const MODEL_CARDS: &[(&str, &str, &str, &str)] = &[
    (
        "fable",
        "Claude Fable",
        "Wizard",
        "The most capable model. Deepest explanations, slowest replies, uses the most of your plan's limits.",
    ),
    (
        "opus",
        "Claude Opus",
        "Sage",
        "Excellent teacher. Thoughtful and clear — the recommended default.",
    ),
    (
        "sonnet",
        "Claude Sonnet",
        "Ranger",
        "Fast and smart. A great everyday choice that's lighter on your limits.",
    ),
    (
        "haiku",
        "Claude Haiku",
        "Sprite",
        "The quickest replies and the lightest on your limits. Best for quick hints.",
    ),
];

/// "claude-opus-5-5" -> "Claude Opus 5.5", "claude-haiku-4-5-20251001" -> "Claude Haiku 4.5".
fn model_name(id: &str) -> String {
    let (mut words, mut version) = (Vec::new(), Vec::new());
    for part in id.split(['-', '_']) {
        if part.chars().all(|c| c.is_ascii_digit()) {
            // Long numbers are release dates, not versions.
            if part.len() < 6 {
                version.push(part);
            }
        } else {
            let mut chars = part.chars();
            let first = chars.next().map(|c| c.to_ascii_uppercase());
            words.push(first.into_iter().chain(chars).collect::<String>());
        }
    }
    let name = words.join(" ");
    if version.is_empty() {
        name
    } else {
        format!("{name} {}", version.join("."))
    }
}

impl AppState {
    fn model_cards(&self) -> Value {
        let p = self.progress.lock().unwrap();
        MODEL_CARDS
            .iter()
            .map(|(alias, family, tag, blurb)| {
                let resolved = p.models.get(*alias);
                json!({
                    "id": alias, "tag": tag, "blurb": blurb,
                    "name": resolved.map(|m| model_name(m)).unwrap_or_else(|| family.to_string()),
                    "resolved": resolved,
                })
            })
            .collect()
    }

    /// Remember which model an alias turned out to be.
    fn note_model(&self, alias: &str, model: &str) {
        if !MODEL_CARDS.iter().any(|(a, ..)| *a == alias) || !model.starts_with("claude-") {
            return;
        }
        let mut p = self.progress.lock().unwrap();
        if p.models.get(alias).map(String::as_str) != Some(model) {
            p.models.insert(alias.to_string(), model.to_string());
            self.save(&p);
        }
    }
}

async fn models(State(s): State<Shared>) -> Json<Value> {
    Json(s.model_cards())
}

/// Ask every alias once (a tiny prompt each) to learn the newest model behind it.
async fn refresh_models(State(s): State<Shared>) -> Json<Value> {
    let mut checks = tokio::task::JoinSet::new();
    for (alias, ..) in MODEL_CARDS {
        let s = s.clone();
        checks.spawn(async move {
            let result = teacher::test_model(alias, "low", &s.ferris_dir(), &s.usage).await;
            (*alias, result)
        });
    }
    let mut errors = Vec::new();
    while let Some(Ok((alias, result))) = checks.join_next().await {
        match result {
            Ok((model, _)) => s.note_model(alias, &model),
            Err(e) => errors.push(json!({"id": alias, "error": e})),
        }
    }
    Json(json!({ "models": s.model_cards(), "errors": errors }))
}

#[derive(Deserialize)]
struct TestReq {
    model: String,
    effort: String,
}

async fn test_model(State(s): State<Shared>, Json(req): Json<TestReq>) -> Json<Value> {
    let effort = if EFFORTS.contains(&req.effort.as_str()) {
        req.effort.as_str()
    } else {
        "low"
    };
    match teacher::test_model(&req.model, effort, &s.ferris_dir(), &s.usage).await {
        Ok((model, reply)) => {
            s.note_model(&req.model, &model);
            Json(json!({"ok": true, "model": model, "reply": reply}))
        }
        Err(e) => Json(json!({"ok": false, "error": e})),
    }
}

async fn explain(Path(code): Path<String>) -> Json<Value> {
    Json(json!({ "code": code, "text": runner::explain(&code).await }))
}

#[derive(Deserialize)]
struct FerrisReq {
    id: String,
    mode: String,
    #[serde(default)]
    code: String,
    #[serde(default)]
    output: String,
    #[serde(default)]
    message: String,
    #[serde(default)]
    history: Vec<(String, String)>,
    #[serde(default)]
    choice: Option<usize>,
}

/// Streams Ferris' reply as newline-delimited JSON events.
async fn ferris(State(s): State<Shared>, Json(req): Json<FerrisReq>) -> Result<Response, ApiError> {
    check_code_size(&req.code)?;
    let (world, _, level) = s.playable(&req.id)?;
    let (world, level) = (world.clone(), level.clone());

    // Hints cost XP, so the server keeps track of the tier.
    let (mode, settings, profile) = {
        let mut p = s.progress.lock().unwrap();
        let tier = if req.mode == "hint" {
            let t = p.hint_tier.entry(req.id.clone()).or_default();
            *t = (*t + 1).min(3);
            *t
        } else {
            0
        };
        let mode = Mode::parse(&req.mode, tier)
            .ok_or(ApiError(StatusCode::BAD_REQUEST, "unknown mode".into()))?;
        s.save(&p);
        (mode, p.settings.clone(), p.learner_profile())
    };

    let (tx, rx) = tokio::sync::mpsc::channel::<Value>(512);
    let state = s.clone();
    tokio::spawn(async move {
        if let Mode::Hint(tier) = mode {
            let _ = tx.send(json!({"type": "hint_tier", "tier": tier})).await;
        }
        let ctx = teacher::Context {
            world: &world,
            level: &level,
            code: &req.code,
            output: &req.output,
            message: &req.message,
            history: &req.history,
            choice: req.choice,
            profile,
            book: state.book.labels(&level.book),
        };

        let reply = if settings.teacher == "offline" {
            Err(None)
        } else {
            let prompt = teacher::build_prompt(mode, &ctx);
            teacher::ask(
                prompt,
                &settings.model,
                &settings.effort,
                &state.ferris_dir(),
                &tx,
                &state.usage,
            )
            .await
            .map_err(Some)
        };

        match reply {
            Ok(teacher::Reply { text, model }) => {
                if let Some(m) = &model {
                    state.note_model(&settings.model, m);
                }
                if mode == Mode::Review
                    && verdict_is_idiomatic(&text)
                    && state.award_review_bonus(&level.id)
                {
                    let _ = tx
                        .send(json!({"type": "bonus", "xp": REVIEW_BONUS_XP}))
                        .await;
                }
            }
            Err(Some(message)) if message == teacher::CANCELLED => {}
            Err(err) => {
                if let Some(message) = err {
                    let _ = tx.send(json!({"type": "error", "message": message})).await;
                }
                let _ = tx.send(json!({"type": "offline"})).await;
                let text = offline_reply(mode, &ctx);
                let _ = tx.send(json!({"type": "delta", "text": text})).await;
            }
        }
        let _ = tx.send(json!({"type": "done"})).await;
    });

    let stream = ReceiverStream::new(rx).map(|v| Ok::<_, std::io::Error>(format!("{v}\n")));
    Ok(Response::builder()
        .header("content-type", "application/x-ndjson")
        .header("cache-control", "no-cache")
        .body(Body::from_stream(stream))
        .unwrap())
}

/// Reads the `VERDICT: idiomatic|improvable` line at the end of a code review.
fn verdict_is_idiomatic(text: &str) -> bool {
    text.rfind("VERDICT")
        .map(|i| text[i..].to_lowercase())
        .is_some_and(|rest| rest.contains("idiomatic") && !rest.contains("improvable"))
}

/// What Ferris says without Claude: built-in hints and error notes.
fn offline_reply(mode: Mode, ctx: &teacher::Context) -> String {
    let level = ctx.level;
    match mode {
        Mode::Hint(tier) => {
            let i = tier as usize - 1;
            match level.hints.get(i) {
                Some(h) => h.clone(),
                None if !level.solution.is_empty() => {
                    format!("Here's one way to solve it:\n```rust\n{}\n```", level.solution.trim())
                }
                None => level.hints.last().cloned().unwrap_or_else(|| "Read the goal once more, slowly. 🦀".into()),
            }
        }
        Mode::Explain => explain_offline(ctx.output),
        Mode::Review => {
            if level.solution.is_empty() {
                "Nicely done! 🎉 (I'm in offline mode, so no detailed review this time.)".into()
            } else {
                format!(
                    "Nicely done! 🎉 I'm in offline mode, so compare your code with my version:\n```rust\n{}\n```",
                    level.solution.trim()
                )
            }
        }
        Mode::Chat => "I'm in **offline mode** right now, so I can't chat. Try a hint (💡) — or switch my brain back on in Settings ⚙.".into(),
        Mode::Quiz => "Not quite! Read the code once more, line by line, and ask: *who owns each value, and when does each line run?* Then try again.".into(),
    }
}

fn explain_offline(output: &str) -> String {
    const NOTES: &[(&str, &str)] = &[
        (
            "E0382",
            "**Use after move.** A value was moved to a new owner, and then the old name was used again. In C this would be a use-after-free waiting to happen; Rust stops it at compile time. Try `.clone()` or (later) borrowing with `&`.",
        ),
        (
            "E0384",
            "**Assigning twice to an immutable variable.** Rust variables can't change unless you say so: `let mut x`.",
        ),
        (
            "E0308",
            "**Mismatched types.** Rust expected one type and got another. Check what each side should be — and watch for a stray `;` at the end of a function, which turns the value into `()`.",
        ),
        (
            "E0425",
            "**Unknown name.** You used a variable or function that doesn't exist here. Check spelling and scope — a name declared inside `{ }` disappears at the `}`.",
        ),
        (
            "E0423",
            "**Expected a function, found a macro.** Macros like `println!` need a `!` after their name.",
        ),
        (
            "E0277",
            "**A trait is missing.** Often this means mixing types, e.g. `i32 * f64`. Rust never converts numbers silently — use `as f64`.",
        ),
        (
            "E0502",
            "**Borrow conflict.** You can't borrow something mutably while it's also borrowed immutably.",
        ),
        (
            "E0499",
            "**Two mutable borrows at once.** Only one `&mut` can exist at a time.",
        ),
        (
            "E0596",
            "**Borrowing as mutable something that isn't `mut`.** Add `mut` where the variable is declared.",
        ),
        (
            "E0599",
            "**No such method.** That type doesn't have a method with this name. Check the spelling and the type.",
        ),
    ];
    let mut out = String::from("I'm in offline mode, but here's what I can tell you:\n\n");
    let mut found = false;
    for (code, note) in NOTES {
        if output.contains(&format!("[{code}]")) {
            out.push_str(&format!("- `{code}` — {note}\n"));
            found = true;
        }
    }
    if !found {
        let first = output
            .lines()
            .find(|l| l.starts_with("error") || l.contains("panicked") || l.contains("FAILED"))
            .unwrap_or("Compare your output with the expected output, line by line.");
        out.push_str(&format!("Start with the **first** problem:\n```\n{first}\n```\nThe `-->` line tells you the line number."));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::levels::{Check, Level, World};
    use crate::progress::Progress;

    fn temp_dir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("ferris-forge-api-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A level that would pass if it were compiled: the fake run results below decide
    /// pass/fail, so no `rustc` is needed for the grading tests.
    fn fake_level(id: &str) -> Level {
        Level {
            id: id.into(),
            title: "A test level".into(),
            kind: Kind::Fix,
            book: vec![],
            goal: "Print the thing.".into(),
            lesson: String::new(),
            c_compare: String::new(),
            py_compare: String::new(),
            starter: "fn main() {}".into(),
            check: Check::Output,
            expected_output: Some("hi".into()),
            tests: None,
            hints: vec!["a hint".into()],
            solution: String::new(),
            choices: vec![],
            answer: None,
            compile_fails: false,
            explanation: String::new(),
            xp: 30,
            stdin: String::new(),
            args: vec![],
            env: Default::default(),
            files: Default::default(),
            expected_stderr: None,
            min_tests: 0,
        }
    }

    fn state_with(save_dir: PathBuf, progress: Progress, levels: Vec<Level>) -> Shared {
        Arc::new(AppState {
            save_dir,
            worlds: vec![World {
                id: 0,
                name: "Test World".into(),
                blurb: String::new(),
                tag: None,
                levels,
                planned: vec![],
            }],
            book: Book {
                base_url: String::new(),
                sections: vec![],
            },
            progress: Mutex::new(progress),
            usage: Arc::new(Mutex::new(None)),
            save_error: Mutex::new(None),
            notice: Mutex::new(None),
            rustc: None,
        })
    }

    /// A normal state whose save file can be written.
    fn working_state(name: &str, progress: Progress) -> Shared {
        state_with(
            temp_dir(name),
            progress,
            vec![fake_level("0.1"), fake_level("0.2")],
        )
    }

    /// A state whose save directory is gone, so every save fails. Used for the
    /// "saving failed" paths: they must report the error and leave progress alone.
    fn unwritable_state(name: &str, progress: Progress) -> Shared {
        let dir = temp_dir(name).join("missing");
        assert!(!dir.exists());
        state_with(dir, progress, vec![fake_level("0.1")])
    }

    fn passed() -> runner::RunResult {
        runner::RunResult {
            compiled: true,
            passed: true,
            ..Default::default()
        }
    }

    fn saved(state: &Shared) -> Progress {
        Progress::load(&state.save_dir.join("progress.json"))
            .unwrap()
            .0
    }

    #[test]
    fn a_cleared_level_pays_out_once() {
        let s = working_state("normal", Progress::default());
        let generation = s
            .begin_run("0.1", "fn main() { println!(\"hi\"); }")
            .unwrap();

        let (_, li, level) = World::find(&s.worlds, "0.1").unwrap();
        let first = s.finish_run(&s.worlds[0], li, level, "0.1", generation, &passed());
        assert_eq!(first["first_clear"], true);
        assert_eq!(first["xp_gained"], 30);
        assert_eq!(first["stale"], Value::Null);
        assert_eq!(s.progress.lock().unwrap().xp, 30);
        assert_eq!(saved(&s).xp, 30, "the clear must reach the save file");
        assert!(saved(&s).drafts.contains_key("0.1"));

        // Running the same level again doesn't pay twice.
        let again = s
            .begin_run("0.1", "fn main() { println!(\"hi\"); }")
            .unwrap();
        let second = s.finish_run(&s.worlds[0], li, level, "0.1", again, &passed());
        assert_eq!(second["first_clear"], false);
        assert_eq!(second["xp_gained"], 0);
        assert_eq!(s.progress.lock().unwrap().xp, 30);
    }

    #[tokio::test]
    async fn a_run_from_before_a_replay_is_stale() {
        let mut progress = Progress::default();
        progress.completed.insert(
            "0.1".into(),
            Completion {
                xp: 30,
                hints_used: 0,
                attempts: 1,
            },
        );
        progress.xp = 30;
        let s = working_state("stale-one", progress);

        // Start a run, then replay the level while it compiles.
        let generation = s.begin_run("0.1", "old attempt").unwrap();
        let res = replay(State(s.clone()), Json(IdReq { id: "0.1".into() }))
            .await
            .unwrap();
        assert_eq!(res.0["xp_returned"], 30);

        let (_, li, level) = World::find(&s.worlds, "0.1").unwrap();
        let out = s.finish_run(&s.worlds[0], li, level, "0.1", generation, &passed());
        assert_eq!(out["stale"], true);
        assert_eq!(out["xp_gained"], 0);
        assert_eq!(out["first_clear"], false);
        assert_eq!(out["world_cleared"], false);
        let p = s.progress.lock().unwrap();
        assert_eq!(p.xp, 0, "the old run must not earn XP for the new attempt");
        assert!(
            !p.completed.contains_key("0.1"),
            "it must not clear the level"
        );
        assert_eq!(p.attempts.get("0.1"), None, "it must not count an attempt");
        assert_eq!(
            p.drafts.get("0.1"),
            None,
            "it must not revive the old draft"
        );
        assert_eq!(p.generation("0.1"), 1);
    }

    #[tokio::test]
    async fn two_replays_in_a_row_make_both_earlier_runs_stale() {
        let mut progress = Progress::default();
        progress.completed.insert(
            "0.1".into(),
            Completion {
                xp: 30,
                hints_used: 0,
                attempts: 1,
            },
        );
        progress.xp = 30;
        let s = working_state("stale-two", progress);

        let run_a = s.begin_run("0.1", "run A").unwrap();
        let first = replay(State(s.clone()), Json(IdReq { id: "0.1".into() }))
            .await
            .unwrap();
        assert_eq!(first.0["xp_returned"], 30);
        let run_b = s.begin_run("0.1", "run B").unwrap();
        let second = replay(State(s.clone()), Json(IdReq { id: "0.1".into() }))
            .await
            .unwrap();
        assert_eq!(
            second.0["xp_returned"], 0,
            "already reset, nothing left to return"
        );
        assert_eq!(s.progress.lock().unwrap().generation("0.1"), 2);

        let (_, li, level) = World::find(&s.worlds, "0.1").unwrap();
        for (label, generation) in [("A", run_a), ("B", run_b)] {
            let out = s.finish_run(&s.worlds[0], li, level, "0.1", generation, &passed());
            assert_eq!(out["stale"], true, "run {label} must be stale");
            assert_eq!(out["xp_gained"], 0, "run {label} must pay no XP");
            assert_eq!(out["first_clear"], false, "run {label} must not clear");
        }
        let p = s.progress.lock().unwrap();
        assert_eq!(p.xp, 0);
        assert!(!p.completed.contains_key("0.1"));
        assert_eq!(p.generation("0.1"), 2, "replays themselves still count");
    }

    #[tokio::test]
    async fn a_run_after_the_last_replay_still_clears() {
        let s = working_state("after-replay", Progress::default());
        let reset = replay(State(s.clone()), Json(IdReq { id: "0.1".into() }))
            .await
            .unwrap();
        assert_eq!(reset.0["xp_returned"], 0);
        let generation = s.begin_run("0.1", "fresh attempt").unwrap();
        let (_, li, level) = World::find(&s.worlds, "0.1").unwrap();
        let out = s.finish_run(&s.worlds[0], li, level, "0.1", generation, &passed());
        assert_eq!(out["stale"], Value::Null);
        assert_eq!(out["first_clear"], true);
        assert_eq!(out["xp_gained"], 30);
        assert_eq!(s.progress.lock().unwrap().xp, 30);
    }

    #[tokio::test]
    async fn a_run_whose_draft_cannot_be_saved_does_not_run_or_score() {
        let s = unwritable_state("run-save-fails", Progress::default());
        let err = run_level(
            State(s.clone()),
            Json(CodeReq {
                id: "0.1".into(),
                code: "fn main() { println!(\"hi\"); }".into(),
            }),
        )
        .await
        .unwrap_err();
        assert_eq!(err.0, StatusCode::INTERNAL_SERVER_ERROR);
        assert!(err.1.contains("wasn't run"), "{}", err.1);
        let p = s.progress.lock().unwrap();
        assert!(p.drafts.is_empty(), "an unsaved draft must not linger");
        assert!(p.completed.is_empty());
        assert_eq!(p.xp, 0);
        assert_eq!(p.generation("0.1"), 0);
        assert!(
            s.save_error.lock().unwrap().is_some(),
            "error is diagnosable"
        );
    }

    #[tokio::test]
    async fn a_replay_whose_save_fails_keeps_the_xp_and_the_clear() {
        let mut progress = Progress::default();
        progress.completed.insert(
            "0.1".into(),
            Completion {
                xp: 30,
                hints_used: 0,
                attempts: 1,
            },
        );
        progress.xp = 30;
        let s = unwritable_state("replay-save-fails", progress);

        let err = replay(State(s.clone()), Json(IdReq { id: "0.1".into() }))
            .await
            .unwrap_err();
        assert_eq!(err.0, StatusCode::INTERNAL_SERVER_ERROR);
        assert!(err.1.contains("wasn't reset"), "{}", err.1);

        let p = s.progress.lock().unwrap();
        assert_eq!(
            p.xp, 30,
            "XP must not be taken back if the reset wasn't saved"
        );
        assert!(p.completed.contains_key("0.1"), "the clear must survive");
        assert_eq!(p.generation("0.1"), 0, "no attempt number was bumped");
        assert!(
            s.save_error.lock().unwrap().is_some(),
            "error is diagnosable"
        );
    }

    #[tokio::test]
    async fn a_draft_whose_save_fails_is_reported_and_not_kept() {
        let s = unwritable_state("draft-save-fails", Progress::default());
        let err = save_draft(
            State(s.clone()),
            Json(CodeReq {
                id: "0.1".into(),
                code: "fn main() {}".into(),
            }),
        )
        .await
        .unwrap_err();
        assert_eq!(err.0, StatusCode::INTERNAL_SERVER_ERROR);
        assert!(err.1.starts_with("Couldn't save"), "{}", err.1);
        assert!(s.progress.lock().unwrap().drafts.is_empty());
    }

    #[test]
    fn model_names_come_from_ids() {
        assert_eq!(model_name("claude-opus-5-5"), "Claude Opus 5.5");
        assert_eq!(model_name("claude-fable-5-1"), "Claude Fable 5.1");
        assert_eq!(model_name("claude-haiku-4-5-20251001"), "Claude Haiku 4.5");
        assert_eq!(model_name("claude-sonnet-6"), "Claude Sonnet 6");
    }

    #[test]
    fn reads_the_review_verdict() {
        assert!(verdict_is_idiomatic("Nice!\n\nVERDICT: idiomatic"));
        assert!(verdict_is_idiomatic("Nice!\n---\n**VERDICT: idiomatic**"));
        assert!(!verdict_is_idiomatic("Close.\nVERDICT: improvable"));
        assert!(!verdict_is_idiomatic(
            "No verdict at all, but idiomatic code"
        ));
    }
}
