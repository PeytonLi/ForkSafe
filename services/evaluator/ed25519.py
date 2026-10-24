from __future__ import annotations

import hashlib

_Q = 2**255 - 19
_L = 2**252 + 27742317777372353535851937790883648493
_D = (-121665 * pow(121666, _Q - 2, _Q)) % _Q
_I = pow(2, (_Q - 1) // 4, _Q)
_IDENTITY = (0, 1, 1, 0)


def _recover_x(y: int, sign: int) -> int | None:
    y2 = y * y % _Q
    xx = (y2 - 1) * pow((_D * y2 + 1) % _Q, _Q - 2, _Q) % _Q
    x = pow(xx, (_Q + 3) // 8, _Q)
    if (x * x - xx) % _Q:
        x = x * _I % _Q
    if (x * x - xx) % _Q:
        return None
    if x == 0 and sign:
        return None
    if (x & 1) != sign:
        x = _Q - x
    return x


def _decode_point(encoded: bytes) -> tuple[int, int, int, int] | None:
    if len(encoded) != 32:
        return None
    value = int.from_bytes(encoded, "little")
    sign = value >> 255
    y = value & ((1 << 255) - 1)
    if y >= _Q:
        return None
    x = _recover_x(y, sign)
    if x is None:
        return None
    return x, y, 1, x * y % _Q


def _encode_point(point: tuple[int, int, int, int]) -> bytes:
    x, y, z, _ = point
    inverse = pow(z, _Q - 2, _Q)
    x = x * inverse % _Q
    y = y * inverse % _Q
    return (y | ((x & 1) << 255)).to_bytes(32, "little")


def _add(
    left: tuple[int, int, int, int], right: tuple[int, int, int, int]
) -> tuple[int, int, int, int]:
    x1, y1, z1, t1 = left
    x2, y2, z2, t2 = right
    a = (y1 - x1) * (y2 - x2) % _Q
    b = (y1 + x1) * (y2 + x2) % _Q
    c = 2 * _D * t1 * t2 % _Q
    d = 2 * z1 * z2 % _Q
    e = (b - a) % _Q
    f = (d - c) % _Q
    g = (d + c) % _Q
    h = (b + a) % _Q
    return e * f % _Q, g * h % _Q, f * g % _Q, e * h % _Q


def _double(point: tuple[int, int, int, int]) -> tuple[int, int, int, int]:
    x, y, z, _ = point
    a = x * x % _Q
    b = y * y % _Q
    c = 2 * z * z % _Q
    d = -a % _Q
    e = ((x + y) * (x + y) - a - b) % _Q
    g = (d + b) % _Q
    f = (g - c) % _Q
    h = (d - b) % _Q
    return e * f % _Q, g * h % _Q, f * g % _Q, e * h % _Q


def _scalar_mult(
    scalar: int, point: tuple[int, int, int, int]
) -> tuple[int, int, int, int]:
    result = _IDENTITY
    addend = point
    while scalar:
        if scalar & 1:
            result = _add(result, addend)
        addend = _double(addend)
        scalar >>= 1
    return result


_BASE_Y = (4 * pow(5, _Q - 2, _Q)) % _Q
_BASE_X = _recover_x(_BASE_Y, 0)
assert _BASE_X is not None
_BASE = (_BASE_X, _BASE_Y, 1, _BASE_X * _BASE_Y % _Q)


def _secret_scalar(seed: bytes) -> tuple[int, bytes]:
    if len(seed) != 32:
        raise ValueError("Ed25519 seed must be 32 bytes")
    digest = hashlib.sha512(seed).digest()
    scalar_bytes = bytearray(digest[:32])
    scalar_bytes[0] &= 248
    scalar_bytes[31] &= 63
    scalar_bytes[31] |= 64
    return int.from_bytes(scalar_bytes, "little"), digest[32:]


def public_key(seed: bytes) -> bytes:
    scalar, _ = _secret_scalar(seed)
    return _encode_point(_scalar_mult(scalar, _BASE))


def sign(seed: bytes, message: bytes) -> bytes:
    scalar, prefix = _secret_scalar(seed)
    public = _encode_point(_scalar_mult(scalar, _BASE))
    nonce = int.from_bytes(hashlib.sha512(prefix + message).digest(), "little") % _L
    encoded_r = _encode_point(_scalar_mult(nonce, _BASE))
    challenge = int.from_bytes(
        hashlib.sha512(encoded_r + public + message).digest(), "little"
    ) % _L
    s = (nonce + challenge * scalar) % _L
    return encoded_r + s.to_bytes(32, "little")


def verify(public: bytes, message: bytes, signature: bytes) -> bool:
    try:
        if len(public) != 32 or len(signature) != 64:
            return False
        encoded_r = signature[:32]
        s = int.from_bytes(signature[32:], "little")
        if s >= _L:
            return False
        point_a = _decode_point(public)
        point_r = _decode_point(encoded_r)
        if point_a is None or point_r is None:
            return False
        challenge = int.from_bytes(
            hashlib.sha512(encoded_r + public + message).digest(), "little"
        ) % _L
        left = _encode_point(_scalar_mult(s, _BASE))
        right = _encode_point(_add(point_r, _scalar_mult(challenge, point_a)))
        return left == right
    except (ArithmeticError, OverflowError, TypeError, ValueError):
        return False
