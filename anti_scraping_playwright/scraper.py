"""
Complete Anti-Blocking Web Scraper for Playwright Python
Includes: User Agent Rotation, Human Behavior, Proxy Rotation, Cookie Cleaning,
Honeypot Detection, Anti-Fingerprinting, Stealth Mode, Tor Support
"""

import json
import os
import random
import re
import tempfile
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, Union

try:
    from playwright.sync_api import (
        Browser,
        BrowserContext,
        Locator,
        Page,
        sync_playwright,
    )
except ImportError:  # pragma: no cover - allows config/tests without playwright installed
    sync_playwright = None
    Browser = BrowserContext = Page = Locator = None

__version__ = "2.0.0"


class ProgressFileError(Exception):
    """Raised when a resume progress file cannot be parsed or has an invalid structure."""



# ============================================================================
# DATA CLASSES
# ============================================================================

@dataclass
class ProxyServer:
    server: str
    username: str | None = None
    password: str | None = None
    
    def to_playwright_format(self) -> dict:
        proxy_dict = {"server": self.server}
        if self.username and self.password:
            proxy_dict["username"] = self.username
            proxy_dict["password"] = self.password
        return proxy_dict


@dataclass
class ScraperConfig:
    # Proxy settings
    proxies: list[ProxyServer] = field(default_factory=list)
    use_tor: bool = False
    tor_port: int = 9050
    tor_control_port: int = 9051
    
    # User agent rotation
    user_agents: list[str] = field(default_factory=list)
    rotate_user_agent: bool = True
    
    # Human behavior
    typing_speed_range: tuple[int, int] = (50, 150)
    action_delay_range: tuple[float, float] = (0.5, 2.0)
    reading_delay_range: tuple[float, float] = (1.0, 3.0)
    enable_human_behavior: bool = True
    
    # Session management
    requests_per_session: int = 10
    auto_rotate_session: bool = True
    clear_cookies: bool = True
    
    # Honeypot detection
    detect_honeypots: bool = True
    
    # Stealth and anti-fingerprinting
    stealth_mode: bool = True
    randomize_viewport: bool = True
    randomize_timezone: bool = True
    
    # Browser settings
    headless: bool = False
    browser_type: str = "chromium"

    # Reliability
    max_retries: int = 3
    retry_backoff: float = 1.5
    proxy_failover: bool = True
    circuit_breaker_threshold: int = 5
    circuit_breaker_cooldown: float = 30.0

    # Adaptive behavior
    adaptive_delays: bool = True
    enable_proxy_health: bool = True

    def __post_init__(self):
        if self.browser_type not in {"chromium", "firefox", "webkit"}:
            raise ValueError("browser_type must be chromium, firefox, or webkit")
        if self.max_retries < 1:
            raise ValueError("max_retries must be >= 1")
        if self.retry_backoff < 1.0:
            raise ValueError("retry_backoff must be >= 1.0")
        if not (0 <= self.action_delay_range[0] <= self.action_delay_range[1]):
            raise ValueError("action_delay_range must be ordered and non-negative")
        if not (0 <= self.reading_delay_range[0] <= self.reading_delay_range[1]):
            raise ValueError("reading_delay_range must be ordered and non-negative")



class HoneypotDetector:
    
    def __init__(self):
        self.honeypot_patterns = {
            'class': [r'honeypot', r'hp-field', r'trap', r'bot-trap', r'hidden-field', 
                     r'invisible', r'display-none', r'screen-reader', r'off-screen'],
            'id': [r'honeypot', r'hp', r'trap', r'bot-field', r'hidden', r'invisible'],
            'name': [r'honeypot', r'hp', r'email_confirm', r'website', r'url', r'trap'],
        }
        self.detected_honeypots = []
    
    def is_invisible_element(self, page: Page, element) -> tuple[bool, float]:
        try:
            visibility_info = page.evaluate("""
                (element) => {
                    const styles = window.getComputedStyle(element);
                    const rect = element.getBoundingClientRect();
                    return {
                        display: styles.display,
                        visibility: styles.visibility,
                        opacity: parseFloat(styles.opacity),
                        position: styles.position,
                        left: parseInt(styles.left),
                        top: parseInt(styles.top),
                        width: rect.width,
                        height: rect.height,
                        ariaHidden: element.getAttribute('aria-hidden'),
                        hidden: element.hasAttribute('hidden')
                    };
                }
            """, element)
            
            visibility_score = 1.0
            
            if visibility_info['display'] == 'none':
                visibility_score = 0
            if visibility_info['visibility'] == 'hidden':
                visibility_score = 0
            if visibility_info['opacity'] < 0.1:
                visibility_score *= visibility_info['opacity'] * 10
            if (
                visibility_info['position'] in ['absolute', 'fixed']
                and (visibility_info['left'] < -9000 or visibility_info['top'] < -9000)
            ):
                visibility_score = 0
            if visibility_info['width'] < 1 or visibility_info['height'] < 1:
                visibility_score = 0
            if visibility_info['ariaHidden'] == 'true':
                visibility_score *= 0.5
            if visibility_info['hidden']:
                visibility_score = 0

            return visibility_score < 0.3, visibility_score
        except Exception:  # noqa: BLE001 - probe failure means treat element as visible
            return False, 1.0
    
    def check_honeypot_patterns(self, element) -> bool:
        try:
            attrs = element.evaluate("""
                (el) => ({
                    className: el.className || '',
                    id: el.id || '',
                    name: el.name || ''
                })
            """)
            
            key_map = {'class': 'className', 'id': 'id', 'name': 'name'}
            for attr_name, patterns in self.honeypot_patterns.items():
                attr_value = attrs.get(key_map.get(attr_name, attr_name), '')
                for pattern in patterns:
                    if re.search(pattern, str(attr_value), re.IGNORECASE):
                        return True
            return False
        except Exception:  # noqa: BLE001 - attribute probe failure means no pattern match
            return False
    
    def is_safe_element(self, page: Page, element: Locator) -> bool:
        try:
            element_handle = element.element_handle()
            is_invisible, _ = self.is_invisible_element(page, element_handle)
            if is_invisible:
                return False
            matches_pattern = self.check_honeypot_patterns(element_handle)
            return not matches_pattern
        except Exception:  # noqa: BLE001 - uninspectable element is treated as unsafe
            return False




class AntiBlockingScraper:
    
    def __init__(self, config: ScraperConfig):
        self.config = config
        self.current_proxy_index = 0
        self.request_count = 0
        self.session_count = 0
        self.honeypot_detector = HoneypotDetector() if config.detect_honeypots else None

        # Adaptive reliability state
        self.proxy_health = {}
        self.recent_failures = 0
        
        if not self.config.user_agents:
            self.config.user_agents = self._get_default_user_agents()
        
        if self.config.use_tor:
            self._setup_tor_proxy()
    
    def _get_default_user_agents(self) -> list[str]:
        return [
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0",
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15",
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        ]
    
    def _setup_tor_proxy(self):
        tor_proxy = ProxyServer(f"socks5://127.0.0.1:{self.config.tor_port}")
        self.config.proxies.insert(0, tor_proxy)
        print(f"✓ Tor proxy configured: socks5://127.0.0.1:{self.config.tor_port}")
    
    def _get_next_proxy(self) -> ProxyServer | None:
        if not self.config.proxies:
            return None

        # Prefer healthy proxies when health tracking is enabled
        if self.config.enable_proxy_health:
            healthy = [p for p in self.config.proxies if self.proxy_health.get(p.server, 1.0) >= 0.5]
            pool = healthy or self.config.proxies
        else:
            pool = self.config.proxies

        # Round-robin within the selected pool
        proxy = pool[self.current_proxy_index % len(pool)]
        self.current_proxy_index = (self.current_proxy_index + 1) % len(pool)
        return proxy

    def record_proxy_result(self, proxy: ProxyServer | None, success: bool):
        if not proxy or not self.config.enable_proxy_health:
            return
        score = self.proxy_health.get(proxy.server, 1.0)
        if success:
            score = min(1.0, score + 0.1)
        else:
            score = max(0.0, score - 0.25)
        self.proxy_health[proxy.server] = score
    
    def _get_random_user_agent(self) -> str:
        return random.choice(self.config.user_agents)
    
    def _get_random_viewport(self) -> dict:
        if not self.config.randomize_viewport:
            return {"width": 1920, "height": 1080}
        
        viewports = [
            {"width": 1920, "height": 1080},
            {"width": 1366, "height": 768},
            {"width": 1536, "height": 864},
            {"width": 1440, "height": 900},
            {"width": 2560, "height": 1440},
        ]
        return random.choice(viewports)
    
    def _get_random_timezone(self) -> str:
        if not self.config.randomize_timezone:
            return "America/New_York"
        
        timezones = [
            "America/New_York", "America/Los_Angeles", "America/Chicago",
            "Europe/London", "Europe/Paris", "Europe/Berlin",
            "Asia/Tokyo", "Asia/Shanghai", "Australia/Sydney"
        ]
        return random.choice(timezones)
    
    def _apply_stealth_mode(self, page: Page):
        if not self.config.stealth_mode:
            return
        
        # Inject stealth scripts
        page.add_init_script("""
            // Overwrite the `plugins` property to use a custom getter
            Object.defineProperty(navigator, 'plugins', {
                get: () => [1, 2, 3, 4, 5]
            });
            
            // Overwrite the `languages` property
            Object.defineProperty(navigator, 'languages', {
                get: () => ['en-US', 'en']
            });
            
            // Overwrite the `webdriver` property
            Object.defineProperty(navigator, 'webdriver', {
                get: () => false
            });
            
            // Mock chrome object
            window.chrome = {
                runtime: {}
            };
            
            // Mock permissions
            const originalQuery = window.navigator.permissions.query;
            window.navigator.permissions.query = (parameters) => (
                parameters.name === 'notifications' ?
                    Promise.resolve({ state: Notification.permission }) :
                    originalQuery(parameters)
            );
            
            // Remove automation indicators
            delete navigator.__proto__.webdriver;
        """)
    
    def _apply_anti_fingerprinting(self, page: Page):
        if not self.config.stealth_mode:
            return
        
        page.add_init_script("""
            // Randomize canvas fingerprinting
            const originalToDataURL = HTMLCanvasElement.prototype.toDataURL;
            HTMLCanvasElement.prototype.toDataURL = function() {
                const context = this.getContext('2d');
                const imageData = context.getImageData(0, 0, this.width, this.height);
                for (let i = 0; i < imageData.data.length; i += 4) {
                    imageData.data[i] += Math.floor(Math.random() * 10) - 5;
                }
                context.putImageData(imageData, 0, 0);
                return originalToDataURL.apply(this, arguments);
            };
            
            // Randomize audio fingerprinting
            const audioContext = window.AudioContext || window.webkitAudioContext;
            if (audioContext) {
                const originalCreateAnalyser = audioContext.prototype.createAnalyser;
                audioContext.prototype.createAnalyser = function() {
                    const analyser = originalCreateAnalyser.call(this);
                    const originalGetFloatFrequencyData = analyser.getFloatFrequencyData;
                    analyser.getFloatFrequencyData = function(array) {
                        originalGetFloatFrequencyData.call(this, array);
                        for (let i = 0; i < array.length; i++) {
                            array[i] += Math.random() * 0.1 - 0.05;
                        }
                    };
                    return analyser;
                };
            }
            
            // Randomize WebGL fingerprinting
            const getParameter = WebGLRenderingContext.prototype.getParameter;
            WebGLRenderingContext.prototype.getParameter = function(parameter) {
                if (parameter === 37445) {
                    return 'Intel Inc.';
                }
                if (parameter === 37446) {
                    return 'Intel Iris OpenGL Engine';
                }
                return getParameter.call(this, parameter);
            };
        """)
    
    def create_stealth_context(self, browser: Browser) -> BrowserContext:
        # Get next proxy if available
        proxy = self._get_next_proxy()
        proxy_config = proxy.to_playwright_format() if proxy else None
        
        # Create context options
        context_options = {
            "viewport": self._get_random_viewport(),
            "locale": "en-US",
            "timezone_id": self._get_random_timezone(),
            "permissions": ["geolocation"],
            "geolocation": {"latitude": 40.7128, "longitude": -74.0060},
            "color_scheme": random.choice(["light", "dark"]),
            "ignore_https_errors": True,
        }
        
        # Add user agent
        if self.config.rotate_user_agent:
            context_options["user_agent"] = self._get_random_user_agent()
        
        # Add proxy
        if proxy_config:
            context_options["proxy"] = proxy_config
        
        # Create context
        context = browser.new_context(**context_options)
        
        self.session_count += 1
        self.last_proxy = proxy
        print(f"✓ Created stealth session #{self.session_count}")
        if proxy:
            print(f"  Proxy: {proxy.server}")

        return context
    
    def random_delay(
        self, min_sec: float | None = None, max_sec: float | None = None
    ):
        if not self.config.enable_human_behavior:
            return

        min_s = min_sec if min_sec is not None else self.config.action_delay_range[0]
        max_s = max_sec if max_sec is not None else self.config.action_delay_range[1]

        # Adaptive delays increase when recent failures are detected
        if self.config.adaptive_delays and self.recent_failures > 0:
            factor = 1 + (self.recent_failures * 0.25)
            min_s *= factor
            max_s *= factor

        delay = random.uniform(min_s, max_s)
        time.sleep(delay)
    
    def human_type(self, page: Page, selector: str, text: str, mistakes: bool = True):
        if not self.config.enable_human_behavior:
            page.fill(selector, text)
            return
        
        element = page.locator(selector)
        element.click()
        self.random_delay(0.1, 0.5)
        
        for i, char in enumerate(text):
            # Occasional typo
            if mistakes and random.random() < 0.05 and i < len(text) - 1:
                wrong_char = random.choice('abcdefghijklmnopqrstuvwxyz')
                element.type(wrong_char, delay=random.randint(*self.config.typing_speed_range))
                time.sleep(random.uniform(0.1, 0.3))
                page.keyboard.press('Backspace')
                time.sleep(random.uniform(0.05, 0.15))
            
            element.type(char, delay=random.randint(*self.config.typing_speed_range))
            
            if random.random() < 0.1:
                time.sleep(random.uniform(0.2, 0.8))
    
    def human_click(self, page: Page, selector: str):
        element = page.locator(selector)
        
        if self.config.enable_human_behavior:
            box = element.bounding_box()
            if box:
                x = box['x'] + box['width'] * random.uniform(0.3, 0.7)
                y = box['y'] + box['height'] * random.uniform(0.3, 0.7)
                page.mouse.move(x, y)
                time.sleep(random.uniform(0.05, 0.2))
        
        element.click()
        self.random_delay(0.3, 1.0)
    
    def human_scroll(self, page: Page, scrolls: int = 3):
        if not self.config.enable_human_behavior:
            return
        
        viewport_height = page.viewport_size['height']
        
        for _ in range(scrolls):
            scroll_amount = viewport_height * random.uniform(0.3, 0.8)
            increments = random.randint(5, 10)
            increment_size = scroll_amount / increments
            
            for _ in range(increments):
                page.mouse.wheel(0, increment_size)
                time.sleep(random.uniform(0.02, 0.05))
            
            time.sleep(random.uniform(1.0, 2.5))
    
    def random_mouse_movement(self, page: Page, movements: int = 3):
        if not self.config.enable_human_behavior:
            return
        
        viewport = page.viewport_size
        for _ in range(movements):
            x = random.randint(0, viewport['width'])
            y = random.randint(0, viewport['height'])
            page.mouse.move(x, y)
            time.sleep(random.uniform(0.1, 0.5))
    
    def safe_click(self, page: Page, selector: str) -> bool:
        if not self.config.detect_honeypots:
            self.human_click(page, selector)
            return True
        
        element = page.locator(selector).first
        if self.honeypot_detector.is_safe_element(page, element):
            self.human_click(page, selector)
            return True
        else:
            print(f"⚠️  Skipped honeypot element: {selector}")
            return False
    
    def get_safe_links(self, page: Page, selector: str = 'a') -> list[Locator]:
        all_links = page.locator(selector).all()
        
        if not self.config.detect_honeypots:
            return all_links
        
        safe_links = [
            link for link in all_links 
            if self.honeypot_detector.is_safe_element(page, link)
        ]
        
        print(f"✓ Found {len(safe_links)} safe links out of {len(all_links)} total")
        return safe_links
    
    def should_rotate_session(self) -> bool:
        if not self.config.auto_rotate_session:
            return False
        
        self.request_count += 1
        return self.request_count >= self.config.requests_per_session
    
    def navigate(self, page: Page, url: str, wait_for: str = "load"):
        # Apply stealth and anti-fingerprinting before navigation
        self._apply_stealth_mode(page)
        self._apply_anti_fingerprinting(page)

        print(f"→ Navigating to: {url}")
        page.goto(url, wait_until=wait_for)

        # Random initial delay (reading page)
        if self.config.enable_human_behavior:
            time.sleep(random.uniform(*self.config.reading_delay_range))
    
    def scrape_with_rotation(self, 
                            urls: list[str], 
                            scrape_callback: Callable[[Page, str], any],
                            **browser_options) -> list[any]:
        """
        Scrape multiple URLs with automatic session rotation.
        
        Args:
            urls: List of URLs to scrape
            scrape_callback: Function(page, url) that performs scraping
            **browser_options: Additional browser launch options
        
        Returns:
            List of results from scrape_callback
        """
        results = []
        
        with sync_playwright() as p:
            # Launch browser
            if self.config.browser_type == "firefox":
                browser = p.firefox.launch(headless=self.config.headless, **browser_options)
            elif self.config.browser_type == "webkit":
                browser = p.webkit.launch(headless=self.config.headless, **browser_options)
            else:
                browser = p.chromium.launch(
                    headless=self.config.headless,
                    args=['--disable-blink-features=AutomationControlled'],
                    **browser_options
                )
            
            context = None
            page = None
            
            for i, url in enumerate(urls):
                print(f"\n{'='*70}")
                print(f"Request {i+1}/{len(urls)}: {url}")
                print('='*70)
                
                # Create new session if needed
                if context is None or self.should_rotate_session():
                    if context:
                        print("🔄 Rotating session...")
                        context.close()
                    
                    context = self.create_stealth_context(browser)
                    page = context.new_page()
                    self.request_count = 0
                
                # Circuit breaker: pause if too many consecutive failures
                if self.recent_failures >= self.config.circuit_breaker_threshold:
                    print(f"⛔ Circuit breaker open: cooling down for {self.config.circuit_breaker_cooldown}s")
                    time.sleep(self.config.circuit_breaker_cooldown)
                    self.recent_failures = 0

                attempt = 0
                success = False
                proxy_used = getattr(self, "last_proxy", None)
                while attempt < self.config.max_retries and not success:
                    attempt += 1
                    try:
                        # Navigate to URL
                        self.navigate(page, url)

                        # Execute scraping callback
                        result = scrape_callback(page, url)
                        results.append(result)

                        print(f"✓ Successfully scraped: {url}")
                        success = True
                        self.recent_failures = 0
                        self.record_proxy_result(proxy_used, True)

                    except Exception as e:  # noqa: BLE001 - retries must absorb every page failure
                        print(f"✗ Attempt {attempt}/{self.config.max_retries} failed for {url}: {e}")
                        self.recent_failures += 1
                        self.record_proxy_result(proxy_used, False)
                        if attempt < self.config.max_retries:
                            backoff = self.config.retry_backoff ** attempt
                            print(f"  Retrying in {backoff:.1f}s...")
                            time.sleep(backoff)
                            if self.config.proxy_failover and self.config.proxies:
                                print("  Rotating proxy/session...")
                                if context:
                                    context.close()
                                context = self.create_stealth_context(browser)
                                page = context.new_page()
                                self.request_count = 0
                                proxy_used = getattr(self, "last_proxy", None)
                        else:
                            results.append(None)
                
                # Random delay between requests
                if i < len(urls) - 1:
                    self.random_delay()
            
            # Cleanup
            if context:
                context.close()
            browser.close()

        return results

    def scrape_with_resume(
        self,
        urls: list[str],
        progress_file: Union[str, "os.PathLike[str]"],
        scrape_callback: Callable[[Page, str], Any],
        **browser_options: Any,
    ) -> dict[str, Any]:
        """
        Scrape a list of URLs with on-disk progress so an interrupted or failed
        run can be resumed without re-scraping finished pages.

        Each successfully scraped URL is appended to ``progress_file`` (a JSON
        document with ``completed_urls`` and ``results`` keys) via an atomic
        temp-file + replace write. Calling this method again with the same
        progress file skips every URL already recorded there and only scrapes
        the remainder; missing files start from empty progress.

        Args:
            urls: URLs to scrape. Duplicate entries are collapsed while
                preserving first-seen order.
            progress_file: JSON file used to persist completed pages.
            scrape_callback: Function(page, url) that performs scraping. It must
                return a JSON-serializable result.
            **browser_options: Additional browser launch options, forwarded to
                :meth:`scrape_with_rotation`.

        Returns:
            Summary dict with ``succeeded``, ``failed``, ``skipped`` counts and
            ``failed_urls``. The ``failed_urls`` list can be passed straight
            back as the ``urls`` argument of a later call to retry them.

        Raises:
            ProgressFileError: If the progress file exists but cannot be parsed
                or does not match the expected structure.
        """
        # De-duplicate while preserving order so each URL maps to one result.
        unique_urls = list(dict.fromkeys(urls))

        state = _load_progress(progress_file)
        completed = set(state["completed_urls"])

        remaining = [url for url in unique_urls if url not in completed]
        skipped = len(unique_urls) - len(remaining)

        succeeded_now: list[str] = []

        def persistent_callback(page: Page, current_url: str) -> Any:
            result = scrape_callback(page, current_url)
            # Persist before acknowledging success so a crash afterwards still
            # leaves the page recorded as completed.
            state["completed_urls"].append(current_url)
            state["results"].append({"url": current_url, "result": result})
            _atomic_write_progress(progress_file, state)
            succeeded_now.append(current_url)
            return result

        failed_urls: list[str] = []
        if remaining:
            # Reuse the existing browser launch, session rotation, retry
            # backoff, proxy-health and circuit-breaker machinery unchanged.
            run_results = self.scrape_with_rotation(
                remaining, persistent_callback, **browser_options
            )
            succeeded_set = set(succeeded_now)
            failed_urls = [
                url
                for url, outcome in zip(remaining, run_results)
                if url not in succeeded_set
            ]

        return {
            "succeeded": len(succeeded_now),
            "failed": len(failed_urls),
            "skipped": skipped,
            "failed_urls": failed_urls,
        }


def _load_progress(progress_file: Union[str, "os.PathLike[str]"]) -> dict[str, Any]:
    """Load resume progress, starting from empty state when the file is absent."""
    if not os.path.exists(progress_file):
        return {"completed_urls": [], "results": []}

    try:
        with open(progress_file, encoding="utf-8") as handle:
            state = json.load(handle)
    except (json.JSONDecodeError, OSError, UnicodeDecodeError) as exc:
        raise ProgressFileError(
            f"Progress file is not valid JSON and cannot be resumed: {progress_file}"
        ) from exc

    if not isinstance(state, dict):
        raise ProgressFileError(
            f"Progress file must contain a JSON object: {progress_file}"
        )

    completed_urls = state.get("completed_urls")
    results = state.get("results")
    if not isinstance(completed_urls, list) or not isinstance(results, list):
        raise ProgressFileError(
            "Progress file must contain 'completed_urls' and 'results' lists: "
            f"{progress_file}"
        )
    if not all(isinstance(url, str) for url in completed_urls):
        raise ProgressFileError(
            f"All entries in 'completed_urls' must be strings: {progress_file}"
        )
    if not all(
        isinstance(entry, dict) and isinstance(entry.get("url"), str)
        for entry in results
    ):
        raise ProgressFileError(
            "Every entry in 'results' must be an object with a string 'url': "
            f"{progress_file}"
        )
    return state


def _atomic_write_progress(
    progress_file: Union[str, "os.PathLike[str]"], state: dict[str, Any]
) -> None:
    """Write progress to a temp file and atomically replace the target."""
    directory = os.path.dirname(os.path.abspath(progress_file))
    os.makedirs(directory, exist_ok=True)
    tmp_handle, tmp_path = tempfile.mkstemp(
        prefix=".progress-", suffix=".tmp", dir=directory
    )
    try:
        with os.fdopen(tmp_handle, "w", encoding="utf-8") as handle:
            json.dump(state, handle, indent=2, ensure_ascii=False)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp_path, progress_file)
    except BaseException:
        # An interrupted write must leave the previous progress file intact.
        try:
            os.remove(tmp_path)
        except OSError:
            pass
        raise










def example_basic_scraping():
    
    # Configure scraper
    config = ScraperConfig(
        proxies=[
            ProxyServer("http://proxy1.example.com:8080"),
            ProxyServer("http://proxy2.example.com:8080"),
        ],
        rotate_user_agent=True,
        enable_human_behavior=True,
        detect_honeypots=True,
        stealth_mode=True,
        requests_per_session=5,
        headless=False
    )
    
    scraper = AntiBlockingScraper(config)
    
    # URLs to scrape
    urls = [
        "https://httpbin.org/headers",
        "https://httpbin.org/user-agent",
        "https://httpbin.org/ip",
    ]
    
    # Define scraping function
    def scrape_page(page: Page, url: str):
        scraper.random_mouse_movement(page)
        
        scraper.human_scroll(page, scrolls=2)
        
        content = page.content()
        print(f"  Page length: {len(content)} bytes")
        
        return {"url": url, "length": len(content)}
    
    scraper.scrape_with_rotation(urls, scrape_page)
    
    print(f"\n{'='*70}")
    print("Scraped pages successfully")
    print('='*70)


def example_with_tor():
    
    config = ScraperConfig(
        use_tor=True,
        tor_port=9050,
        rotate_user_agent=True,
        enable_human_behavior=True,
        stealth_mode=True,
        headless=False
    )
    
    scraper = AntiBlockingScraper(config)
    
    def scrape_page(page: Page, url: str):
        scraper.human_scroll(page, scrolls=1)
        title = page.title()
        print(f"  Title: {title}")
        return {"url": url, "title": title}
    
    urls = ["https://check.torproject.org/"]
    scraper.scrape_with_rotation(urls, scrape_page)


def example_form_submission():
    
    config = ScraperConfig(
        enable_human_behavior=True,
        detect_honeypots=True,
        stealth_mode=True,
        headless=False
    )
    
    scraper = AntiBlockingScraper(config)
    
    def fill_form(page: Page, url: str):
        # Human-like typing
        scraper.human_type(page, "#username", "john_doe", mistakes=True)
        scraper.human_type(page, "#email", "john@example.com", mistakes=True)
        
        # Safe click (avoids honeypots)
        scraper.safe_click(page, "#submit")
        
        return {"status": "submitted"}
    
    urls = ["https://example.com/form"]
    scraper.scrape_with_rotation(urls, fill_form)


def example_advanced_scraping():
    
    config = ScraperConfig(
        proxies=[ProxyServer("http://proxy.example.com:8080")],
        rotate_user_agent=True,
        enable_human_behavior=True,
        detect_honeypots=True,
        stealth_mode=True,
        requests_per_session=3,
        headless=False
    )
    
    scraper = AntiBlockingScraper(config)
    
    def scrape_news(page: Page, url: str):
        # Get safe links only
        safe_links = scraper.get_safe_links(page, 'a.storylink')
        
        articles = []
        for link in safe_links[:5]:
            title = link.text_content()
            href = link.get_attribute('href')
            articles.append({"title": title, "url": href})
            print(f"  Found article: {title}")
        
        return articles
    
    urls = ["https://news.ycombinator.com"]
    scraper.scrape_with_rotation(urls, scrape_news)





if __name__ == "__main__":
    print("="*70)
    print("Anti-Blocking Web Scraper")
    print("="*70)
    
    print("\n  Important Notes:")
    print("  1. Replace example proxies with real ones")
    print("  2. For Tor: Install Tor Browser and ensure it's running")
    print("  3. Respect robots.txt and website terms of service")
    print("  4. Use responsibly and ethically")
    
    print("\n" + "="*70)
    print("Running Example: Basic Scraping")
    print("="*70)
    
    # Uncomment to run examples
    # example_basic_scraping()
    # example_with_tor()
    # example_form_submission()
    # example_advanced_scraping()
    
    print("\n✓ Code ready! Uncomment examples to run.")
