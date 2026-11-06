# Fixtures for the `identikey` domain

Two kinds of file live here, and they prove different things. Read "What is NOT cross-checked" below
before trusting either more than it deserves.

## `auth-v1/`: bytes made by the Rust reference

Copied **unmodified** from <https://github.com/identikey/identikey-protocol>, directory
`crates/identikey-auth/tests/fixtures/`, at commit `e4fe668c7e6b21d6fb103d755dffcef86dd286e1`
(2026-11-04). The upstream licence is Apache-2.0 OR BSD-2-Clause-Patent; the attribution is in the
repository's `NOTICE.md`.

| File                   | Bytes | sha256                                                             |
| ---------------------- | ----: | ------------------------------------------------------------------ |
| `challenge.bin`        |    66 | `2b955e74a5b4b5b03796caa7877f2eeda29c2aedb09c9fd6084c140199ca11d8` |
| `response-ed25519.bin` |   216 | `90b178e9eb781317aadfe4db53e769f1ba5eb1843ef450ca69d47e716e7f7e46` |
| `response-p256.bin`    |   211 | `a372a27b835a718a5b1c394edf968f2adad287c182c22f45b055b7d18cfec801` |

What they are, from the Rust crate's `tests/vectors.rs`:

- `challenge.bin`: the dCBOR map `{v: 1, aud: "identikey-vector", exp: 1700000120, iat: 1700000000,
nonce: 16 x 0x42}`.
- `response-ed25519.bin`: the answer from the Ed25519 key whose seed is `0x11` x 32. Ed25519 signing is
  deterministic, so `softwareSigner.spec.ts` rebuilds this file **byte for byte** from the seed.
  That is the strongest cross-implementation evidence in this directory.
- `response-p256.bin`: the answer from the P-256 key whose secret scalar is `0x22` x 32. The Rust crate
  signs with RFC 6979 nonces; Node's OpenSSL picks a random one, so the TypeScript signature bytes
  differ. The key, the challenge echo and the algorithm tags still match field for field, and the Rust
  signature verifies under the TypeScript verifier.

## `ml-dsa/vectors.json`: bytes made by a different implementation

The Rust repository commits no ML-DSA fixture, so these were produced by `dilithium-py` 1.5.1, a
pure-Python FIPS 204 implementation that shares no code with `@noble/post-quantum`, which the
TypeScript uses. Key generation is from the seed `00 01 .. 1f`; signing is ML-DSA pure mode, empty
context, deterministic (`rnd` = 32 zero bytes), over the 97-byte signing payload
`dCBOR(["identikey-auth/v1", "challenge", <challenge.bin>])`. `mlDsa.spec.ts` checks that noble derives
the same public keys, produces the same signatures, and verifies these.

A hybrid response (the Rust Ed25519 signature plus the Python ML-DSA signature over the same payload)
is assembled in `fixtures.spec.ts` and must pass `pq-required`.

## Where the other pinned constants came from

The constants typed into `blake3.spec.ts`, `base58.spec.ts`, `keys.spec.ts` and `ed25519.spec.ts` are
the printed output of the script at the bottom of this file, which uses the official `blake3` package,
a six-line big-integer base58, hand-assembled CBOR, and the RFC 8032 section 7.1 vectors, which the script
asserts OpenSSL reproduces. Nothing in it imports the code under test.

## What is NOT cross-checked

- **ML-DSA against the Rust `fips204` crate.** The ML-DSA bytes agree between two independent
  implementations, neither of which is the Rust one. Rust-generated ML-DSA and hybrid-response
  fixtures would close this, and are the first thing to add if the upstream repository grows them.
- **A hybrid response produced by the Rust crate.** The one used here is assembled from a Rust Ed25519
  signature and a Python ML-DSA signature.
- **The Rust test suite itself.** The `.bin` files are the bytes upstream committed; this change did not
  rebuild them.
- **P-256 signatures from any implementation other than the Rust crate and OpenSSL.**
- **Phase 2 onward** (key registration, Biscuit capabilities, `identikey-share`, `identikey-log`) has no
  fixtures yet because it has no code yet.

## Regenerating `ml-dsa/vectors.json` and the printed constants

```sh
python3 -m venv venv
venv/bin/pip install dilithium-py==1.5.1 blake3==1.0.11 cryptography==50.0.2
# save the script below as gen_vectors.py, then:
venv/bin/python -I gen_vectors.py auth-v1/challenge.bin ml-dsa/
git diff --exit-code ml-dsa/vectors.json   # no output: the committed file is reproduced exactly
```

<details>
<summary><code>gen_vectors.py</code></summary>

```python
"""
Independent vectors for the IdentiKey Phase 1 tests.

Everything here is computed by code that shares NOTHING with the TypeScript under test:
  * ML-DSA        dilithium-py 1.5.1 (pure-Python FIPS 204), not @noble/post-quantum
  * BLAKE3        the `blake3` PyPI package (the official Rust implementation), not @noble/hashes
  * dCBOR bytes   assembled by hand below, not by the TypeScript encoder
  * base58        a six-line big-integer implementation below, not the TypeScript one
  * Ed25519       the RFC 8032 section 7.1 vectors below; `cryptography` (OpenSSL) must reproduce them

Run:  python -I gen_vectors.py <path to challenge.bin> <output dir for ml-dsa vectors.json>
"""
import json
import sys

from blake3 import blake3
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from dilithium_py.ml_dsa import ML_DSA_44, ML_DSA_65, ML_DSA_87

ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"


def b58encode(data: bytes) -> str:
    n = int.from_bytes(data, "big")
    out = ""
    while n:
        n, r = divmod(n, 58)
        out = ALPHABET[r] + out
    pad = len(data) - len(data.lstrip(b"\x00"))
    return "1" * pad + out


def head(major: int, n: int) -> bytes:
    mt = major << 5
    if n < 24:
        return bytes([mt | n])
    if n <= 0xFF:
        return bytes([mt | 24, n])
    if n <= 0xFFFF:
        return bytes([mt | 25]) + n.to_bytes(2, "big")
    raise ValueError("not needed here")


def text(s: str) -> bytes:
    b = s.encode()
    return head(3, len(b)) + b


def bstr(b: bytes) -> bytes:
    return head(2, len(b)) + b


def key_map(alg: str, key: bytes) -> bytes:
    # { "alg": alg, "key": key } with keys already in canonical order: "alg" < "key"
    return head(5, 2) + text("alg") + text(alg) + text("key") + bstr(key)


chal_path, out_dir = sys.argv[1], sys.argv[2]
chal = open(chal_path, "rb").read()

# ─── signing payload, by hand: dCBOR([ "identikey-auth/v1", "challenge", chal ]) ───
payload = head(4, 3) + text("identikey-auth/v1") + text("challenge") + bstr(chal)
print("signing_payload", len(payload), payload.hex())

# ─── ML-DSA ─────────────────────────────────────────────────────────────────
seed = bytes(range(32))
vectors = {}
for name, impl in (("ml-dsa-44", ML_DSA_44), ("ml-dsa-65", ML_DSA_65), ("ml-dsa-87", ML_DSA_87)):
    pk, sk = impl.key_derive(seed)
    sig = impl.sign(sk, payload, ctx=b"", deterministic=True)
    assert impl.verify(pk, payload, sig, ctx=b"")
    assert not impl.verify(pk, payload, sig, ctx=b"\x01"), "context must matter"
    vectors[name] = {"publicKey": pk.hex(), "signature": sig.hex()}
    print(name, "pk", len(pk), "sig", len(sig))

doc = {
    "$comment": "Produced by dilithium-py 1.5.1 (pure-Python FIPS 204, independent of @noble/post-quantum). "
    "KeyGen from `seed`; sign = ML-DSA.Sign, pure mode, ctx = empty, DETERMINISTIC (rnd = 32 zero bytes). "
    "`message` is dCBOR([\"identikey-auth/v1\",\"challenge\",<challenge.bin>]) assembled by hand.",
    "seed": seed.hex(),
    "message": payload.hex(),
    "vectors": vectors,
}
with open(out_dir + "/vectors.json", "w") as fh:
    json.dump(doc, fh, indent=2)
    fh.write("\n")

# ─── fingerprints of the Rust fixture keys ─────────────────────────────────────
fixtures = {
    "ed25519": bytes.fromhex("d04ab232742bb4ab3a1368bd4615e4e6d0224ab71a016baf8520a332c9778737"),
    "p256": bytes.fromhex("03d65a93977caa3d1b081852ff57a79e465f1660577304baead505dd3a48589cf3"),
}
for alg, key in fixtures.items():
    encoded = key_map(alg, key)
    fp = blake3(encoded).digest()
    print("fingerprint", alg, "dcbor", encoded.hex())
    print("fingerprint", alg, "hex", fp.hex(), "b58", b58encode(fp))

# ─── BLAKE3 over the official test-vector input pattern: byte i is i % 251 ───────────
print("blake3 vectors")
for n in (0, 1, 2, 3, 63, 64, 65, 127, 128, 129, 1023, 1024, 1025, 2048, 2049, 3072, 3073, 4096, 5120, 102400):
    data = bytes(i % 251 for i in range(n))
    print("  ", n, blake3(data).hexdigest())

# ─── base58 ───────────────────────────────────────────────────────────────────
print("base58 vectors")
for hx in (
    "",
    "00",
    "0000",
    "61",
    "626262",
    "636363",
    "73696d706c792061206c6f6e6720737472696e67",
    "00eb15231dfceb60925886b67d065299925915aeb172c06647",
    "516b6fcd0f",
    "bf4f89001e670274dd",
    "572e4794",
    "ecac89cad93923c02321",
    "10c8511e",
    "00000000000000000000",
    "48656c6c6f20576f726c6421",
):
    print("  ", repr(hx), b58encode(bytes.fromhex(hx)))

# ─── RFC 8032 section 7.1 TESTs 1 to 3: OpenSSL must reproduce every key and signature ───
print("rfc8032")
rfc = [
    (
        "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60",
        "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",
        "",
        "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b",
    ),
    (
        "4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb",
        "3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c",
        "72",
        "92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00",
    ),
    (
        "c5aa8df43f9f837bedb7442f31dcb7b166d38535076f094b85ce3a2e0b4458f7",
        "fc51cd8e6218a1a38da47ed00230f0580816ed13ba3303ac5deb911548908025",
        "af82",
        "6291d657deec24024827e69c3abe01a30ce548a284743a445e3680d7db5ac3ac18ff9b538d16f290ae67f760984dc6594a7c15e9716ed28dc027beceea1ec40a",
    ),
]
for sk_hex, pk_hex, msg_hex, sig_hex in rfc:
    sk = Ed25519PrivateKey.from_private_bytes(bytes.fromhex(sk_hex))
    derived_pk = sk.public_key().public_bytes_raw().hex()
    msg = bytes.fromhex(msg_hex)
    derived_sig = sk.sign(msg).hex()
    assert derived_pk == pk_hex, f"public key for seed {sk_hex[:8]} differs"
    assert derived_sig == sig_hex, f"signature for seed {sk_hex[:8]} differs"
    print("  seed", sk_hex[:8], "key and signature reproduced")
```

</details>
