"""Fetch remote images with a minimal SSRF guard.

Only http/https URLs that resolve exclusively to public addresses are allowed.
Redirects are followed manually so every hop is re-checked, and the body is
streamed into memory with a hard size cap and timeouts.

Callers should turn a failure into user-facing text with
:func:`describe_fetch_failure`. It maps every exception raised by
:func:`fetch_image` to a stable :class:`FetchFailureReason` code, a Chinese
message and the HTTP status the route should use. Neither the exception text
nor the message includes a resolved address, so an internal IP that a hostname
resolves to is never echoed back to the client.

Residual risk: we validate the resolved addresses and then let ``requests``
resolve the name again when it connects (DNS rebinding). Closing that window
would mean pinning the connection to a validated IP, which is not worth the
complexity for the authenticated cover-art and preview endpoints. The image
content-type requirement also limits what an attacker can exfiltrate through
the response.
"""

import ipaddress
import socket
from dataclasses import dataclass
from enum import Enum
from urllib.parse import urljoin, urlparse

import requests

MAX_IMAGE_BYTES = 10 * 1024 * 1024  # 10 MB
MAX_REDIRECTS = 3
CONNECT_TIMEOUT_SECONDS = 5
READ_TIMEOUT_SECONDS = 15
_REDIRECT_STATUSES = (301, 302, 303, 307, 308)
_CHUNK_SIZE = 64 * 1024


class FetchFailureReason(str, Enum):
    """Stable, machine-readable reasons a remote image fetch can fail.

    The values are part of the API: the frontend may switch on them, so do not
    rename an existing member. Adding a member is backwards compatible.
    """

    # Non-http(s) scheme, missing host, embedded credentials, an unresolvable
    # host, or a host that resolves to a non-public address.
    INVALID_URL = 'invalid_url'
    # More redirect hops than the caller allows.
    TOO_MANY_REDIRECTS = 'too_many_redirects'
    # Declared or streamed body larger than the size cap.
    CONTENT_TOO_LARGE = 'content_too_large'
    # The response Content-Type is not image/*.
    NOT_AN_IMAGE = 'not_an_image'
    # Connection failure, timeout, DNS/socket error before validation, or a
    # non-success HTTP status.
    NETWORK_ERROR = 'network_error'


# User-facing Chinese explanations keyed by reason. They intentionally contain
# no host names or addresses: a private IP must never reach the response.
FAILURE_MESSAGES = {
    FetchFailureReason.INVALID_URL: (
        '图片地址不可用：请使用可解析的公网 http 或 https 地址。'
    ),
    FetchFailureReason.TOO_MANY_REDIRECTS: (
        '图片地址重定向次数过多，请改用可直达图片的地址。'
    ),
    FetchFailureReason.CONTENT_TOO_LARGE: (
        '图片超过大小上限，请换用更小的图片。'
    ),
    FetchFailureReason.NOT_AN_IMAGE: (
        '该地址返回的内容不是图片。'
    ),
    FetchFailureReason.NETWORK_ERROR: (
        '无法下载图片，请检查地址或稍后重试。'
    ),
}

# HTTP status a route should return for each reason. Bad input is a 400,
# an oversized body is a 413, and an upstream problem is a 502.
_STATUS_BY_REASON = {
    FetchFailureReason.INVALID_URL: 400,
    FetchFailureReason.TOO_MANY_REDIRECTS: 400,
    FetchFailureReason.CONTENT_TOO_LARGE: 413,
    FetchFailureReason.NOT_AN_IMAGE: 400,
    FetchFailureReason.NETWORK_ERROR: 502,
}
_TIMEOUT_STATUS = 504


@dataclass(frozen=True)
class FetchFailure:
    """A route-friendly description of a failed fetch.

    ``code`` is stable and machine-readable, ``message`` is the Chinese text
    to show the user and ``status`` is the matching HTTP status code.
    """

    code: str
    message: str
    status: int

    def as_dict(self):
        """Return the JSON error payload a route can return verbatim.

        ``error`` keeps the convention every other endpoint uses, so existing
        clients show the explanation unchanged; ``code`` is what new clients
        can branch on.
        """
        return {'error': self.message, 'code': self.code}


class FetchError(ValueError):
    """Base class for fetch failures; carries a stable reason code."""

    reason = FetchFailureReason.NETWORK_ERROR

    def __init__(self, message, reason=None):
        super().__init__(message)
        self.reason = FetchFailureReason(reason) if reason is not None else self.reason

    @property
    def code(self):
        """The stable reason code as a plain string."""
        return self.reason.value


class UnsafeURLError(FetchError):
    """Raised when a URL is not a public http/https URL or is not an image."""

    reason = FetchFailureReason.INVALID_URL


class ImageTooLargeError(FetchError):
    """Raised when the remote image exceeds the size limit."""

    reason = FetchFailureReason.CONTENT_TOO_LARGE


def describe_fetch_failure(error):
    """Map an exception from :func:`fetch_image` to a :class:`FetchFailure`.

    The returned code is stable across releases; the message is meant for the
    user. Both are generic by design and never include a resolved address, so
    an internal IP that a hostname resolved to cannot leak through them.
    """
    if isinstance(error, FetchError):
        reason = error.reason
        status = _STATUS_BY_REASON[reason]
    elif isinstance(error, requests.exceptions.Timeout):
        reason = FetchFailureReason.NETWORK_ERROR
        status = _TIMEOUT_STATUS
    else:
        # requests.RequestException and socket errors, plus anything
        # unexpected the route might pass in: report it as an upstream
        # failure rather than inventing a misleading reason.
        reason = FetchFailureReason.NETWORK_ERROR
        status = _STATUS_BY_REASON[reason]

    return FetchFailure(reason.value, FAILURE_MESSAGES[reason], status)


def _is_public_address(address):
    """Return True only for globally routable unicast addresses."""
    try:
        ip = ipaddress.ip_address(address)
    except ValueError:
        return False

    # Unwrap IPv4-mapped/compatible IPv6 so ::ffff:127.0.0.1 is caught.
    if isinstance(ip, ipaddress.IPv6Address):
        if ip.ipv4_mapped is not None:
            ip = ip.ipv4_mapped
        elif ip.sixtofour is not None or ip.teredo is not None:
            # 6to4/Teredo tunnel addresses can embed a private IPv4 target.
            return False

    return (
        ip.is_global
        and not ip.is_multicast
        and not ip.is_unspecified
        and not ip.is_loopback
        and not ip.is_link_local
        and not ip.is_private
        and not ip.is_reserved
    )


def _resolve_public_ips(host):
    try:
        infos = socket.getaddrinfo(host, None, type=socket.SOCK_STREAM)
    except (socket.gaierror, UnicodeError):
        # The host name only; the reason descriptor stays generic too.
        raise UnsafeURLError(f'Could not resolve host: {host}')

    addresses = {info[4][0] for info in infos}
    if not addresses:
        raise UnsafeURLError(f'Could not resolve host: {host}')

    for address in addresses:
        if not _is_public_address(address):
            # Deliberately no address in the text: it must not be echoed.
            raise UnsafeURLError('URL points to a non-public address')
    return addresses


def validate_public_url(url):
    """Validate scheme, host and resolved addresses; raise UnsafeURLError."""
    if not isinstance(url, str):
        raise UnsafeURLError('URL must be a string')

    try:
        parsed = urlparse(url)
        hostname = parsed.hostname
    except ValueError:
        # Malformed bracketed IPv6 literals and similar parse failures.
        raise UnsafeURLError('Invalid URL')

    if parsed.scheme not in ('http', 'https'):
        raise UnsafeURLError('Only http and https URLs are allowed')
    if not hostname:
        raise UnsafeURLError('URL is missing a host')
    if parsed.username or parsed.password:
        raise UnsafeURLError('URLs with embedded credentials are not allowed')
    _resolve_public_ips(hostname)
    return parsed


def fetch_image(url, user_agent, max_bytes=MAX_IMAGE_BYTES, max_redirects=MAX_REDIRECTS):
    """Download an image from a public URL.

    Returns ``(image_bytes, mime_type)`` with the MIME type normalised to its
    lower-case ``type/subtype`` form. Raises ``UnsafeURLError``,
    ``ImageTooLargeError`` or ``requests.RequestException``; pass the caught
    exception to :func:`describe_fetch_failure` for a user-facing code/message.
    """
    headers = {'User-Agent': user_agent}

    for _ in range(max_redirects + 1):
        # Revalidated on every hop, including the first one. A redirect to a
        # private host fails here, before another request is made.
        validate_public_url(url)

        response = requests.get(
            url,
            headers=headers,
            timeout=(CONNECT_TIMEOUT_SECONDS, READ_TIMEOUT_SECONDS),
            allow_redirects=False,
            stream=True,
        )
        try:
            if response.status_code in _REDIRECT_STATUSES:
                location = response.headers.get('Location')
                if not location:
                    # A malformed response, not a bad user-supplied address.
                    raise UnsafeURLError(
                        'Redirect response had no Location header',
                        FetchFailureReason.NETWORK_ERROR,
                    )
                url = urljoin(url, location)
                continue

            response.raise_for_status()

            declared_length = response.headers.get('Content-Length', '')
            if declared_length.isdigit() and int(declared_length) > max_bytes:
                raise ImageTooLargeError('Image is too large')

            content_type = response.headers.get('Content-Type', '')
            content_type = content_type.split(';')[0].strip().lower()
            if not content_type.startswith('image/'):
                raise UnsafeURLError(
                    'URL did not return an image',
                    FetchFailureReason.NOT_AN_IMAGE,
                )

            data = bytearray()
            for chunk in response.iter_content(chunk_size=_CHUNK_SIZE):
                data.extend(chunk)
                if len(data) > max_bytes:
                    raise ImageTooLargeError('Image is too large')

            return bytes(data), content_type
        finally:
            # Closed on every path: success, redirect hop, limit breach,
            # bad content type and HTTP errors.
            response.close()

    raise UnsafeURLError(
        f'Too many redirects (max {max_redirects})',
        FetchFailureReason.TOO_MANY_REDIRECTS,
    )
