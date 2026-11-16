"""Anti-Scraping Playwright toolkit."""

from .scraper import AntiBlockingScraper, ProgressFileError, ProxyServer, ScraperConfig

__version__ = "2.0.0"
__all__ = [
    "AntiBlockingScraper",
    "ProgressFileError",
    "ProxyServer",
    "ScraperConfig",
    "__version__",
]
