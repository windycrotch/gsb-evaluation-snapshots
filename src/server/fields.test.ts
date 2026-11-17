import { test } from "node:test";
import assert from "node:assert/strict";
import { collectFields, fillPages, type PageJSON } from "./fields.js";

function page(id: string, objects: unknown[]): PageJSON {
  return { id, canvas_json: JSON.stringify({ version: "6.0.0", objects }) };
}

const HEADLINE = { type: "textbox", text: "Your inspiring quote goes here", fieldName: "headline" };
const LOGO = { type: "image", src: "https://example.com/old.png", fieldName: "logo" };
const HOOK = { type: "text", text: "old hook", fieldName: "hook" };
const UNTAGGED = { type: "textbox", text: "not a field" };

test("collectFields reports name, type and current value", () => {
  const fields = collectFields([page("p1", [HEADLINE, LOGO, UNTAGGED])]);

  assert.deepEqual(fields, [
    { name: "headline", type: "text", value: "Your inspiring quote goes here", page_ids: ["p1"] },
    { name: "logo", type: "image", value: "https://example.com/old.png", page_ids: ["p1"] },
  ]);
});

test("a name reused across pages is one field listing every page", () => {
  const fields = collectFields([page("p1", [LOGO]), page("p2", [LOGO])]);

  assert.equal(fields.length, 1);
  assert.deepEqual(fields[0].page_ids, ["p1", "p2"]);
});

test("fields inside groups are found", () => {
  const fields = collectFields([page("p1", [{ type: "group", objects: [HEADLINE] }])]);

  assert.deepEqual(fields.map((f) => f.name), ["headline"]);
});

test("Fabric v6's capitalised type names are recognised", () => {
  // A canvas that has been through the editor serialises as "Textbox"/"Image"/
  // "Rect", not the lowercase names used in the seed templates. Both must work.
  const objects = [
    { type: "Textbox", text: "hi", fieldName: "headline" },
    { type: "Image", src: "https://example.com/a.png", fieldName: "logo" },
    { type: "Rect", fill: "#000", fieldName: "backdrop" },
  ];

  assert.deepEqual(
    collectFields([page("p1", objects)]).map((f) => [f.name, f.type]),
    [
      ["headline", "text"],
      ["logo", "image"],
    ]
  );
});

test("a tag on an object that is neither text nor image is ignored", () => {
  assert.deepEqual(collectFields([page("p1", [{ type: "rect", fieldName: "box" }])]), []);
});

test("blank and non-string field names are ignored", () => {
  const objects = [
    { type: "textbox", text: "a", fieldName: "   " },
    { type: "textbox", text: "b", fieldName: 42 },
  ];
  assert.deepEqual(collectFields([page("p1", objects)]), []);
});

test("empty and corrupt canvases are skipped, not thrown on", () => {
  const pages = [
    { id: "p1", canvas_json: "{}" },
    { id: "p2", canvas_json: "not json" },
    page("p3", [HEADLINE]),
  ];
  assert.deepEqual(collectFields(pages).map((f) => f.name), ["headline"]);
});

test("fill writes text and image by the object's own type", () => {
  const result = fillPages([page("p1", [HEADLINE, LOGO])], {
    headline: "Q3 revenue up 40%",
    logo: "https://example.com/new.png",
  });

  const objects = JSON.parse(result.pages[0].canvas_json).objects;
  assert.equal(objects[0].text, "Q3 revenue up 40%");
  assert.equal(objects[1].src, "https://example.com/new.png");
  assert.deepEqual(result.filled.sort(), ["headline", "logo"]);
  assert.deepEqual(result.unmatched, []);
  assert.deepEqual(result.replacements, { headline: 1, logo: 1 });
  assert.deepEqual(result.skipped_pages, []);
});

test("one name on two pages fills both", () => {
  const result = fillPages([page("p1", [LOGO]), page("p2", [LOGO])], {
    logo: "https://example.com/new.png",
  });

  for (const filledPage of result.pages) {
    assert.equal(JSON.parse(filledPage.canvas_json).objects[0].src, "https://example.com/new.png");
  }
  assert.deepEqual(result.replacements, { logo: 2 });
});

test("a name repeated on several objects and pages counts every replacement", () => {
  const result = fillPages(
    [
      page("p1", [HEADLINE, LOGO, { ...HEADLINE }]),
      page("p2", [LOGO]),
      page("p3", [HOOK]),
    ],
    { headline: "new", logo: "https://example.com/new.png", hook: "sub" }
  );

  assert.deepEqual(result.replacements, { headline: 2, logo: 2, hook: 1 });
  assert.deepEqual(result.filled.sort(), ["headline", "hook", "logo"]);
  // The reported totals must match what is actually in the returned canvases.
  const replaced = result.pages.flatMap((p) =>
    JSON.parse(p.canvas_json).objects.filter((o: { fieldName?: string }) => o.fieldName)
  );
  assert.equal(replaced.length, Object.values(result.replacements).reduce((a, b) => a + b, 0));
});

test("a name shared by a text and an image writes each object's own property", () => {
  const result = fillPages([page("p1", [HEADLINE, { type: "image", src: "old", fieldName: "headline" }])], {
    headline: "shared",
  });

  const [text, image] = JSON.parse(result.pages[0].canvas_json).objects;
  assert.equal(text.text, "shared");
  assert.equal(text.src, undefined);
  assert.equal(image.src, "shared");
  assert.equal(image.text, undefined);
  assert.deepEqual(result.replacements, { headline: 2 });
});

test("a name absent from values is left alone and unlisted", () => {
  const result = fillPages([page("p1", [HEADLINE, LOGO])], { headline: "new" });

  const objects = JSON.parse(result.pages[0].canvas_json).objects;
  assert.equal(objects[0].text, "new");
  assert.equal(objects[1].src, "https://example.com/old.png");
  assert.deepEqual(result.replacements, { headline: 1 });
  assert.deepEqual(result.unmatched, []);
});

test("an unknown name is reported, not fatal", () => {
  const result = fillPages([page("p1", [LOGO])], {
    logo: "https://example.com/new.png",
    nope: "y",
  });

  assert.deepEqual(result.filled, ["logo"]);
  assert.deepEqual(result.unmatched, ["nope"]);
  assert.deepEqual(result.replacements, { logo: 1 });
});

test("fill does not mutate the pages it was given", () => {
  const original = page("p1", [HEADLINE]);
  const before = original.canvas_json;

  fillPages([original], { headline: "changed" });

  assert.equal(original.canvas_json, before);
});

test("untouched pages are returned unchanged", () => {
  const pages = [page("p1", [HEADLINE]), page("p2", [UNTAGGED])];
  const result = fillPages(pages, { headline: "changed" });

  assert.equal(result.pages[1].canvas_json, pages[1].canvas_json);
});

test("filling with an empty string clears the text rather than being skipped", () => {
  const result = fillPages([page("p1", [HEADLINE])], { headline: "" });

  assert.equal(JSON.parse(result.pages[0].canvas_json).objects[0].text, "");
  assert.deepEqual(result.filled, ["headline"]);
  assert.deepEqual(result.replacements, { headline: 1 });
  assert.deepEqual(result.unmatched, []);
});

test("an empty string is a value for images too, and still counts", () => {
  const result = fillPages([page("p1", [LOGO]), page("p2", [LOGO])], { logo: "" });

  for (const filledPage of result.pages) {
    assert.equal(JSON.parse(filledPage.canvas_json).objects[0].src, "");
  }
  assert.deepEqual(result.filled, ["logo"]);
  assert.deepEqual(result.replacements, { logo: 2 });
});

test("a corrupt canvas is returned untouched and its id is reported", () => {
  const bad = { id: "bad", canvas_json: "not json" };
  const result = fillPages([page("p1", [HEADLINE]), bad], { headline: "new" });

  assert.equal(result.pages[1], bad);
  assert.equal(result.pages[1].canvas_json, "not json");
  assert.deepEqual(result.skipped_pages, ["bad"]);
  assert.deepEqual(result.replacements, { headline: 1 });
  assert.equal(JSON.parse(result.pages[0].canvas_json).objects[0].text, "new");
});

test("non-object canvas blobs are skipped; an empty blob is a valid empty canvas", () => {
  const result = fillPages(
    [
      { id: "empty", canvas_json: "" },
      { id: "null", canvas_json: "null" },
      { id: "number", canvas_json: "42" },
      page("ok", [LOGO]),
    ],
    { logo: "https://example.com/new.png" }
  );

  assert.deepEqual(result.skipped_pages, ["null", "number"]);
  assert.equal(result.pages[0].canvas_json, "");
  assert.deepEqual(result.replacements, { logo: 1 });
});

test("a name that only appears on skipped pages stays unmatched", () => {
  const result = fillPages(
    [
      { id: "bad", canvas_json: "{" },
      page("p2", [HEADLINE]),
    ],
    { headline: "new", ghost: "x" }
  );

  assert.deepEqual(result.skipped_pages, ["bad"]);
  assert.deepEqual(result.filled, ["headline"]);
  assert.deepEqual(result.replacements, { headline: 1 });
  assert.deepEqual(result.unmatched, ["ghost"]);
});

test("a value with no matching object never invents a replacement entry", () => {
  const result = fillPages([page("p1", [UNTAGGED])], { headline: "new" });

  assert.deepEqual(result.replacements, {});
  assert.deepEqual(result.filled, []);
  assert.deepEqual(result.unmatched, ["headline"]);
  assert.equal(result.pages[0].canvas_json, page("p1", [UNTAGGED]).canvas_json);
});

test("every input page comes back exactly once, skipped pages included", () => {
  // The save path persists `result.pages` verbatim, so page count and order
  // here are what a saved design will hold alongside these stats.
  const pages = [
    page("p1", [HEADLINE]),
    { id: "bad", canvas_json: "{" },
    page("p3", [LOGO]),
  ];
  const result = fillPages(pages, { headline: "new", logo: "https://example.com/new.png" });

  assert.deepEqual(result.pages.map((p) => p.id), ["p1", "bad", "p3"]);
  assert.deepEqual(result.skipped_pages, ["bad"]);
  assert.deepEqual(result.replacements, { headline: 1, logo: 1 });
});
