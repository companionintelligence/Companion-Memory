/**
 * Test vectors from the DIDComm reference implementation in Rust (sicpa-dlab/didcomm-rust, commit
 * 4388350, 2024-08-14; Apache-2.0), src/test_vectors/{encrypted,signed,plaintext,from_prior_jwt}.rs.
 * Generated verbatim; do not edit by hand. They use the same Alice and Bob keys as the DIDComm
 * Messaging specification's appendix, plus Charlie (did:example:charlie#key-1, Ed25519), the
 * signer of the from_prior JWTs.
 *
 * Plaintext vectors are kept as raw text because some are intentionally not JSON objects.
 */

export const RUST_ENCRYPTED_ANON_XC20P_1: Record<string, unknown> = {
  ciphertext:
    'KWS7gJU7TbyJlcT9dPkCw-ohNigGaHSukR9MUqFM0THbCTCNkY-g5tahBFyszlKIKXs7qOtqzYyWbPou2q77XlAeYs93IhF6NvaIjyNqYklvj-OtJt9W2Pj5CLOMdsR0C30wchGoXd6wEQZY4ttbzpxYznqPmJ0b9KW6ZP-l4_DSRYe9B-1oSWMNmqMPwluKbtguC-riy356Xbu2C9ShfWmpmjz1HyJWQhZfczuwkWWlE63g26FMskIZZd_jGpEhPFHKUXCFwbuiw_Iy3R0BIzmXXdK_w7PZMMPbaxssl2UeJmLQgCAP8j8TukxV96EKa6rGgULvlo7qibjJqsS5j03bnbxkuxwbfyu3OxwgVzFWlyHbUH6p',
  protected:
    'eyJlcGsiOnsia3R5IjoiT0tQIiwiY3J2IjoiWDI1NTE5IiwieCI6IkpIanNtSVJaQWFCMHpSR193TlhMVjJyUGdnRjAwaGRIYlc1cmo4ZzBJMjQifSwiYXB2IjoiTmNzdUFuclJmUEs2OUEtcmtaMEw5WFdVRzRqTXZOQzNaZzc0QlB6NTNQQSIsInR5cCI6ImFwcGxpY2F0aW9uL2RpZGNvbW0tZW5jcnlwdGVkK2pzb24iLCJlbmMiOiJYQzIwUCIsImFsZyI6IkVDREgtRVMrQTI1NktXIn0',
  recipients: [
    {
      encrypted_key: '3n1olyBR3nY7ZGAprOx-b7wYAKza6cvOYjNwVg3miTnbLwPP_FmE1A',
      header: {
        kid: 'did:example:bob#key-x25519-1',
      },
    },
    {
      encrypted_key: 'j5eSzn3kCrIkhQAWPnEwrFPMW6hG0zF_y37gUvvc5gvlzsuNX4hXrQ',
      header: {
        kid: 'did:example:bob#key-x25519-2',
      },
    },
    {
      encrypted_key: 'TEWlqlq-ao7Lbynf0oZYhxs7ZB39SUWBCK4qjqQqfeItfwmNyDm73A',
      header: {
        kid: 'did:example:bob#key-x25519-3',
      },
    },
  ],
  tag: '6ylC_iAs4JvDQzXeY6MuYQ',
  iv: 'ESpmcyGiZpRjc5urDela21TOOTW8Wqd1',
};

export const RUST_ENCRYPTED_ANON_XC20P_2: Record<string, unknown> = {
  ciphertext:
    '912eTUDRKTzhUUqxosPogT1bs9w9wv4s4HmoWkaeU9Uj92V4ENpk-_ZPNSvPyXYLfFj0nc9V2-ux5jq8hqUd17WJpXEM1ReMUjtnTqeUzVa7_xtfkbfhaOZdL8OfgNquPDH1bYcBshN9O9lMT0V52gmGaAB45k4I2PNHcc0A5XWzditCYi8wOkPDm5A7pA39Au5uUNiFQjRYDrz1YvJwV9cdca54vYsBfV1q4c8ncQsv5tNnFYQ1s4rAG7RbyWdAjkC89kE_hIoRRkWZhFyNSfdvRtlUJDlM19uml7lwBWWPnqkmQ3ubiBGmVct3pjrcDvjissOw8Dwkn4E1V1gafec-jDBy4Rndai_RdGjnXjMJs7nRv3Ot',
  protected:
    'eyJlcGsiOnsia3R5IjoiRUMiLCJjcnYiOiJQLTI1NiIsIngiOiJFczdpUDNFaExDSGxBclAwS2NZRmNxRXlCYXByMks2WU9BOVc4ZU84YXU4IiwieSI6Ik42QWw3RVR3Q2RwQzZOamRlY3IyS1hBZzFVZVp5X3VmSFJRS3A5RzZLR2sifSwiYXB2Ijoiei1McXB2VlhEYl9zR1luM21qUUxwdXUyQ1FMZXdZdVpvVFdPSVhQSDNGTSIsInR5cCI6ImFwcGxpY2F0aW9uL2RpZGNvbW0tZW5jcnlwdGVkK2pzb24iLCJlbmMiOiJYQzIwUCIsImFsZyI6IkVDREgtRVMrQTI1NktXIn0',
  recipients: [
    {
      encrypted_key: 'G-UFZ1ebuhlWZTrMj214YcEvHl6hyfsFtWv4hj-NPNi9gpi99rRs3Q',
      header: {
        kid: 'did:example:bob#key-p256-1',
      },
    },
    {
      encrypted_key: 'gVdbFdXAxEgrtj9Uw2xiEucQukpiAOA3Jp7Ecmb6L7G5c3IIcAAHgQ',
      header: {
        kid: 'did:example:bob#key-p256-2',
      },
    },
  ],
  tag: 't8ioLvZhsCp7A93jvdf3wA',
  iv: 'JrIpD5q5ifMq6PT06pYh6QhCQ6LgnGpF',
};

export const RUST_ENCRYPTED_AUTH_X25519: Record<string, unknown> = {
  ciphertext:
    'MJezmxJ8DzUB01rMjiW6JViSaUhsZBhMvYtezkhmwts1qXWtDB63i4-FHZP6cJSyCI7eU-gqH8lBXO_UVuviWIqnIUrTRLaumanZ4q1dNKAnxNL-dHmb3coOqSvy3ZZn6W17lsVudjw7hUUpMbeMbQ5W8GokK9ZCGaaWnqAzd1ZcuGXDuemWeA8BerQsfQw_IQm-aUKancldedHSGrOjVWgozVL97MH966j3i9CJc3k9jS9xDuE0owoWVZa7SxTmhl1PDetmzLnYIIIt-peJtNYGdpd-FcYxIFycQNRUoFEr77h4GBTLbC-vqbQHJC1vW4O2LEKhnhOAVlGyDYkNbA4DSL-LMwKxenQXRARsKSIMn7z-ZIqTE-VCNj9vbtgR',
  protected:
    'eyJlcGsiOnsia3R5IjoiT0tQIiwiY3J2IjoiWDI1NTE5IiwieCI6IkdGY01vcEpsamY0cExaZmNoNGFfR2hUTV9ZQWY2aU5JMWRXREd5VkNhdzAifSwiYXB2IjoiTmNzdUFuclJmUEs2OUEtcmtaMEw5WFdVRzRqTXZOQzNaZzc0QlB6NTNQQSIsInNraWQiOiJkaWQ6ZXhhbXBsZTphbGljZSNrZXkteDI1NTE5LTEiLCJhcHUiOiJaR2xrT21WNFlXMXdiR1U2WVd4cFkyVWphMlY1TFhneU5UVXhPUzB4IiwidHlwIjoiYXBwbGljYXRpb24vZGlkY29tbS1lbmNyeXB0ZWQranNvbiIsImVuYyI6IkEyNTZDQkMtSFM1MTIiLCJhbGciOiJFQ0RILTFQVStBMjU2S1cifQ',
  recipients: [
    {
      encrypted_key:
        'o0FJASHkQKhnFo_rTMHTI9qTm_m2mkJp-wv96mKyT5TP7QjBDuiQ0AMKaPI_RLLB7jpyE-Q80Mwos7CvwbMJDhIEBnk2qHVB',
      header: {
        kid: 'did:example:bob#key-x25519-1',
      },
    },
    {
      encrypted_key:
        'rYlafW0XkNd8kaXCqVbtGJ9GhwBC3lZ9AihHK4B6J6V2kT7vjbSYuIpr1IlAjvxYQOw08yqEJNIwrPpB0ouDzKqk98FVN7rK',
      header: {
        kid: 'did:example:bob#key-x25519-2',
      },
    },
    {
      encrypted_key:
        'aqfxMY2sV-njsVo-_9Ke9QbOf6hxhGrUVh_m-h_Aq530w3e_4IokChfKWG1tVJvXYv_AffY7vxj0k5aIfKZUxiNmBwC_QsNo',
      header: {
        kid: 'did:example:bob#key-x25519-3',
      },
    },
  ],
  tag: 'uYeo7IsZjN7AnvBjUZE5lNryNENbf6_zew_VC-d4b3U',
  iv: 'o02OXDQ6_-sKz2PX_6oyJg',
};

export const RUST_ENCRYPTED_AUTH_P256: Record<string, unknown> = {
  ciphertext:
    'WCufCs2lMZfkxQ0JCK92lPtLFgwWk_FtRWOMj52bQISa94nEbIYqHDUohIbvLMgbSjRcJVusZO04UthDuOpSSTcV5GBi3O0cMrjyI_PZnTb1yikLXpXma1bT10D2r5TPtzRMxXF3nFsr9y0JKV1TsMtn70Df2fERx2bAGxcflmd-A2sMlSTT8b7QqPtn17Yb-pA8gr4i0Bqb2WfDzwnbfewbukpRmPA2hsEs9oLKypbniAafSpoiQjfb19oDfsYaWWXqsdjTYMflqH__DqSmW52M-SUp6or0xU0ujbHmOkRkcdh9PsR5YsPuIWAqYa2hfjz_KIrGTxvCos0DMiZ4Lh_lPIYQqBufSdFH5AGChoekFbQ1vcyIyYMFugzOHOgZ2TwEzv94GCgokBHQR4_qaU_f4Mva64KPwqOYdm5f4KX16afTJa-IV7ar7__2L-A-LyxmC5KIHeGOedV9kzZBLC7TuzRAuE3vY7pkhLB1jPE6XpTeKXldljaeOSEVcbFUQtsHOSPz9JXuhqZ1fdAx8qV7hUnSAd_YMMDR3S6SXtem8ak2m98WPvKIxhCbcto7W2qoNYMT7MPvvid-QzUvTdKtyovCvLzhyYJzMjZxmn9-EnGhZ5ITPL_xFfLyKxhSSUVz3kSwK9xuOj3KpJnrrD7xrp5FKzEaJVIHWrUW90V_9QVLjriThZ36fA3ipvs8ZJ8QSTnGAmuIQ6Z2u_r4KsjL_mGAgn47qyqRm-OSLEUE4_2qB0Q9Z7EBKakCH8VPt09hTMDR62aYZYwtmpNs9ISu0VPvFjh8UmKbFcQsVrz90-x-r-Q1fTX9JaIFcDy7aqKcI-ai3tVF_HDR60Jaiw',
  protected:
    'eyJlcGsiOnsia3R5IjoiRUMiLCJjcnYiOiJQLTI1NiIsIngiOiJObHJ3UHZ0SUluZWNpeUVrYTRzMi00czhPalRidEZFQVhmTC12Z2x5enFvIiwieSI6ImhiMnZkWE5zSzVCQ2U3LVhaQ0dfLTY0R21UT19rNUlNWFBaQ00xdGFUQmcifSwiYXB2Ijoiei1McXB2VlhEYl9zR1luM21qUUxwdXUyQ1FMZXdZdVpvVFdPSVhQSDNGTSIsInNraWQiOiJkaWQ6ZXhhbXBsZTphbGljZSNrZXktcDI1Ni0xIiwiYXB1IjoiWkdsa09tVjRZVzF3YkdVNllXeHBZMlVqYTJWNUxYQXlOVFl0TVEiLCJ0eXAiOiJhcHBsaWNhdGlvbi9kaWRjb21tLWVuY3J5cHRlZCtqc29uIiwiZW5jIjoiQTI1NkNCQy1IUzUxMiIsImFsZyI6IkVDREgtMVBVK0EyNTZLVyJ9',
  recipients: [
    {
      encrypted_key:
        'ZIL6Leligq1Xps_229nlo1xB_tGxOEVoEEMF-XTOltI0QXjyUoq_pFQBCAnVdcWNH5bmaiuzCYOmZ9lkyXBkfHO90KkGgODG',
      header: {
        kid: 'did:example:bob#key-p256-1',
      },
    },
    {
      encrypted_key:
        'sOjs0A0typIRSshhQoiJPoM4o7YpR5LA8SSieHZzmMyIDdD8ww-4JyyQhqFYuvfS4Yt37VF4z7Nd0OjYVNRL-iqPnoJ3iCOr',
      header: {
        kid: 'did:example:bob#key-p256-2',
      },
    },
  ],
  tag: 'nIpa3EQ29hgCkA2cBPde2HpKXK4_bvmL2x7h39rtVEc',
  iv: 'mLqi1bZLz7VwqtVVFsDiLg',
};

export const RUST_INVALID_ANON_P256_EPK_WRONG_POINT: Record<string, unknown> = {
  protected:
    'eyJ0eXAiOiJhcHBsaWNhdGlvbi9kaWRjb21tLWVuY3J5cHRlZCtqc29uIiwiYWxnIjoiRUNESC1FUytBMjU2S1ciLCJlbmMiOiJYQzIwUCIsImFwdSI6bnVsbCwiYXB2Ijoiei1McXB2VlhEYl9zR1luM21qUUxwdXUyQ1FMZXdZdVpvVFdPSVhQSDNGTSIsImVwayI6eyJjcnYiOiJQLTI1NiIsImt0eSI6IkVDIiwieCI6IkZSQW1UQmljUFZJXy1aRnF2WEJwNzZhV2pZM0gzYlpGZlhocHRUNm1ETnciLCJ5IjoiLXZ0LTFIaHRvVjBwN2xrbGIxTnRvMWRhU0lqQnV3cVZzbGIwcC1uOWRrdyJ9fQ==',
  recipients: [
    {
      header: {
        kid: 'did:example:bob#key-p256-1',
      },
      encrypted_key: 'scQxV9YQ4mQrUHgl6yAnBFDXNZAiIs_15bmoErUmoYm0HtuRclPoQg',
    },
    {
      header: {
        kid: 'did:example:bob#key-p256-2',
      },
      encrypted_key: 'CqZ-HDH2j0NC-eoUueNLKyAuMQXjQyw8bJHYM2f-lxJVm3eXCdmm2g',
    },
  ],
  iv: 'Vg1uyuQKrU6Kw8OJK38WCpYFxW0suAP9',
  ciphertext:
    '2nIm3xQcFR3HXbUPF1HS_D92OGVDvL0nIi6O5ol5tnMIa09NxJtbVAYIG7ZrkT9314PqXn_Rq77hgGE6FAOgO7aNYLyUJh0JCC_i2p_XOWuk20BYyBsmmRvVpg0DY3I1Lb-Vg1pT9pEy09gsMSLhbfqk0_TFJB1rcqzR8W0YZB5mX_53nMRf1ZatDEg4rDogSekWEGTBnlTNRua8-zoI4573SfgJ-ONt7Z_KbGO-sdRkmqXhfYNcbUyoMF9JSa-kraVuWHZP9hTz8-7R020EXfb4jodMWVOMMAiJYk1Cd7tetHXpLPdtuokaapofmtL_SNftAX2CB6ULf0axrHUNtvUyjAPvpgvSuvQuMrDlaXn16MQJ_q55',
  tag: 'etLTQvKsTvF629fykLiUDg',
};

export const RUST_SIGNED_MSG_ALICE_KEY_1: Record<string, unknown> = {
  payload:
    'eyJpZCI6IjEyMzQ1Njc4OTAiLCJ0eXAiOiJhcHBsaWNhdGlvbi9kaWRjb21tLXBsYWluK2pzb24iLCJ0eXBlIjoiaHR0cDovL2V4YW1wbGUuY29tL3Byb3RvY29scy9sZXRzX2RvX2x1bmNoLzEuMC9wcm9wb3NhbCIsImZyb20iOiJkaWQ6ZXhhbXBsZTphbGljZSIsInRvIjpbImRpZDpleGFtcGxlOmJvYiJdLCJjcmVhdGVkX3RpbWUiOjE1MTYyNjkwMjIsImV4cGlyZXNfdGltZSI6MTUxNjM4NTkzMSwiYm9keSI6eyJtZXNzYWdlc3BlY2lmaWNhdHRyaWJ1dGUiOiJhbmQgaXRzIHZhbHVlIn19',
  signatures: [
    {
      protected: 'eyJ0eXAiOiJhcHBsaWNhdGlvbi9kaWRjb21tLXNpZ25lZCtqc29uIiwiYWxnIjoiRWREU0EifQ',
      signature: 'FW33NnvOHV0Ted9-F7GZbkia-vYAfBKtH4oBxbrttWAhBZ6UFJMxcGjL3lwOl4YohI3kyyd08LHPWNMgP2EVCQ',
      header: {
        kid: 'did:example:alice#key-1',
      },
    },
  ],
};

export const RUST_SIGNED_MSG_ALICE_KEY_2: Record<string, unknown> = {
  payload:
    'eyJpZCI6IjEyMzQ1Njc4OTAiLCJ0eXAiOiJhcHBsaWNhdGlvbi9kaWRjb21tLXBsYWluK2pzb24iLCJ0eXBlIjoiaHR0cDovL2V4YW1wbGUuY29tL3Byb3RvY29scy9sZXRzX2RvX2x1bmNoLzEuMC9wcm9wb3NhbCIsImZyb20iOiJkaWQ6ZXhhbXBsZTphbGljZSIsInRvIjpbImRpZDpleGFtcGxlOmJvYiJdLCJjcmVhdGVkX3RpbWUiOjE1MTYyNjkwMjIsImV4cGlyZXNfdGltZSI6MTUxNjM4NTkzMSwiYm9keSI6eyJtZXNzYWdlc3BlY2lmaWNhdHRyaWJ1dGUiOiJhbmQgaXRzIHZhbHVlIn19',
  signatures: [
    {
      protected: 'eyJ0eXAiOiJhcHBsaWNhdGlvbi9kaWRjb21tLXNpZ25lZCtqc29uIiwiYWxnIjoiRVMyNTYifQ',
      signature: 'gcW3lVifhyR48mLHbbpnGZQuziskR5-wXf6IoBlpa9SzERfSG9I7oQ9pssmHZwbvJvyMvxskpH5oudw1W3X5Qg',
      header: {
        kid: 'did:example:alice#key-2',
      },
    },
  ],
};

export const RUST_SIGNED_MSG_ALICE_KEY_3: Record<string, unknown> = {
  payload:
    'eyJpZCI6IjEyMzQ1Njc4OTAiLCJ0eXAiOiJhcHBsaWNhdGlvbi9kaWRjb21tLXBsYWluK2pzb24iLCJ0eXBlIjoiaHR0cDovL2V4YW1wbGUuY29tL3Byb3RvY29scy9sZXRzX2RvX2x1bmNoLzEuMC9wcm9wb3NhbCIsImZyb20iOiJkaWQ6ZXhhbXBsZTphbGljZSIsInRvIjpbImRpZDpleGFtcGxlOmJvYiJdLCJjcmVhdGVkX3RpbWUiOjE1MTYyNjkwMjIsImV4cGlyZXNfdGltZSI6MTUxNjM4NTkzMSwiYm9keSI6eyJtZXNzYWdlc3BlY2lmaWNhdHRyaWJ1dGUiOiJhbmQgaXRzIHZhbHVlIn19',
  signatures: [
    {
      protected: 'eyJ0eXAiOiJhcHBsaWNhdGlvbi9kaWRjb21tLXNpZ25lZCtqc29uIiwiYWxnIjoiRVMyNTZLIn0',
      signature: 'EGjhIcts6tqiJgqtxaTiTY3EUvL-_rLjn9lxaZ4eRUwa1-CS1nknZoyJWbyY5NQnUafWh5nvCtQpdpMyzH3blw',
      header: {
        kid: 'did:example:alice#key-3',
      },
    },
  ],
};

export const RUST_PLAINTEXT: Record<string, string> = {
  PLAINTEXT_MSG_SIMPLE:
    '{\n    "id": "1234567890",\n    "typ": "application/didcomm-plain+json",\n    "type": "http://example.com/protocols/lets_do_lunch/1.0/proposal",\n    "from": "did:example:alice",\n    "to": ["did:example:bob"],\n    "created_time": 1516269022,\n    "expires_time": 1516385931,\n    "body": {"messagespecificattribute": "and its value"}\n}',
  PLAINTEXT_MSG_SIMPLE_NO_TYP:
    '{\n    "id": "1234567890",\n    "type": "http://example.com/protocols/lets_do_lunch/1.0/proposal",\n    "from": "did:example:alice",\n    "to": ["did:example:bob"],\n    "created_time": 1516269022,\n    "expires_time": 1516385931,\n    "body": {"messagespecificattribute": "and its value"}\n}',
  PLAINTEXT_MSG_MINIMAL:
    '{\n    "id": "1234567890",\n    "typ": "application/didcomm-plain+json",\n    "type": "http://example.com/protocols/lets_do_lunch/1.0/proposal",\n    "body": {}\n}',
  PLAINTEXT_FROM_PRIOR:
    '{\n    "id": "1234567890",\n    "typ": "application/didcomm-plain+json",\n    "type": "http://example.com/protocols/lets_do_lunch/1.0/proposal",\n    "from": "did:example:alice",\n    "to": ["did:example:bob"],\n    "created_time": 1516269022,\n    "expires_time": 1516385931,\n    "from_prior": "eyJ0eXAiOiJKV1QiLCJhbGciOiJFZERTQSIsImtpZCI6ImRpZDpleGFtcGxlOmNoYXJsaWUja2V5LTEifQ.eyJpc3MiOiJkaWQ6ZXhhbXBsZTpjaGFybGllIiwic3ViIjoiZGlkOmV4YW1wbGU6YWxpY2UiLCJhdWQiOiIxMjMiLCJleHAiOjEyMzQsIm5iZiI6MTIzNDUsImlhdCI6MTIzNDU2LCJqdGkiOiJkZmcifQ.ir0tegXiGJIZIMagO5P853KwhzGTEw0OpFFAyarUV-nQrtbI_ELbxT9l7jPBoPve_-60ifGJ9v3ArmFjELFlDA",\n    "body": {"messagespecificattribute": "and its value"}\n}',
  PLAINTEXT_INVALID_FROM_PRIOR:
    '{\n    "id": "1234567890",\n    "typ": "application/didcomm-plain+json",\n    "type": "http://example.com/protocols/lets_do_lunch/1.0/proposal",\n    "from": "did:example:alice",\n    "to": ["did:example:bob"],\n    "created_time": 1516269022,\n    "expires_time": 1516385931,\n    "from_prior": "invalid",\n    "body": {"messagespecificattribute": "and its value"}\n}',
  PLAINTEXT_FROM_PRIOR_INVALID_SIGNATURE:
    '{\n    "id": "1234567890",\n    "typ": "application/didcomm-plain+json",\n    "type": "http://example.com/protocols/lets_do_lunch/1.0/proposal",\n    "from": "did:example:alice",\n    "to": ["did:example:bob"],\n    "created_time": 1516269022,\n    "expires_time": 1516385931,\n    "from_prior": "eyJ0eXAiOiJKV1QiLCJhbGciOiJFZERTQSIsImtpZCI6ImRpZDpleGFtcGxlOmNoYXJsaWUja2V5LTEifQ.eyJpc3MiOiJkaWQ6ZXhhbXBsZTpjaGFybGllIiwic3ViIjoiZGlkOmV4YW1wbGU6YWxpY2UiLCJhdWQiOiIxMjMiLCJleHAiOjEyMzQsIm5iZiI6MTIzNDUsImlhdCI6MTIzNDU2LCJqdGkiOiJkZmcifQ.ir0tegXiGJIZIMagO5P853KwhzGTEw0OpFFAyarUV-nQrtbI_ELbxT9l7jPBoPve_-60ifGJ9v3ArmFjELFlDB",\n    "body": {"messagespecificattribute": "and its value"}\n}',
  PLAINTEXT_MSG_ATTACHMENT_BASE64:
    '{\n    "id": "1234567890",\n    "typ": "application/didcomm-plain+json",\n    "type": "http://example.com/protocols/lets_do_lunch/1.0/proposal",\n    "from": "did:example:alice",\n    "to": ["did:example:bob"],\n    "created_time": 1516269022,\n    "expires_time": 1516385931,\n    "body": {"messagespecificattribute": "and its value"},\n    "attachments": [{"id": "23", "data": {"base64": "qwerty"}}]\n}',
  PLAINTEXT_MSG_ATTACHMENT_LINKS:
    '{\n    "id": "1234567890",\n    "typ": "application/didcomm-plain+json",\n    "type": "http://example.com/protocols/lets_do_lunch/1.0/proposal",\n    "from": "did:example:alice",\n    "to": ["did:example:bob"],\n    "created_time": 1516269022,\n    "expires_time": 1516385931,\n    "body": {"messagespecificattribute": "and its value"},\n    "attachments": [\n        {"id": "23", "data": {"links": ["1", "2", "3"], "hash": "qwerty"}}\n    ]\n}',
  PLAINTEXT_MSG_ATTACHMENT_JSON:
    '{\n    "id": "1234567890",\n    "typ": "application/didcomm-plain+json",\n    "type": "http://example.com/protocols/lets_do_lunch/1.0/proposal",\n    "from": "did:example:alice",\n    "to": ["did:example:bob"],\n    "created_time": 1516269022,\n    "expires_time": 1516385931,\n    "body": {"messagespecificattribute": "and its value"},\n    "attachments": [\n        {"id": "23", "data": {"json": {"foo": "bar", "links": [2, 3]}}}\n    ]\n}',
  PLAINTEXT_MSG_ATTACHMENT_MULTI_1:
    '{\n    "id": "1234567890",\n    "typ": "application/didcomm-plain+json",\n    "type": "http://example.com/protocols/lets_do_lunch/1.0/proposal",\n    "from": "did:example:alice",\n    "to": ["did:example:bob"],\n    "created_time": 1516269022,\n    "expires_time": 1516385931,\n    "body": {"messagespecificattribute": "and its value"},\n    "attachments": [\n        {"id": "23", "data": {"json": {"foo": "bar", "links": [2, 3]}}},\n        {"id": "24", "data": {"base64": "qwerty"}},\n        {"id": "25", "data": {"links": ["1", "2", "3"], "hash": "qwerty"}}\n    ]\n}',
  PLAINTEXT_MSG_ATTACHMENT_MULTI_2:
    '{\n    "id": "1234567890",\n    "typ": "application/didcomm-plain+json",\n    "type": "http://example.com/protocols/lets_do_lunch/1.0/proposal",\n    "from": "did:example:alice",\n    "to": ["did:example:bob"],\n    "created_time": 1516269022,\n    "expires_time": 1516385931,\n    "body": {"messagespecificattribute": "and its value"},\n    "attachments": [\n        {"id": "23", "data": {"links": ["1", "2", "3"], "hash": "qwerty"}},\n        {"id": "24", "data": {"base64": "qwerty"}},\n        {"id": "25", "data": {"links": ["1", "2", "3", "4"], "hash": "qwerty2"}}\n    ]\n}',
  INVALID_PLAINTEXT_MSG_EMPTY: '{}',
  INVALID_PLAINTEXT_MSG_STRING: 'aaaa',
  INVALID_PLAINTEXT_MSG_NO_ID:
    '{\n    "typ": "application/didcomm-plain+json",\n    "type": "http://example.com/protocols/lets_do_lunch/1.0/proposal",\n    "body": {}\n}',
  INVALID_PLAINTEXT_MSG_NO_TYPE:
    '{\n    "id": "1234567890",\n    "typ": "application/didcomm-plain+json",\n    "body": {}\n}',
  INVALID_PLAINTEXT_MSG_NO_BODY:
    '{\n    "id": "1234567890",\n    "typ": "application/didcomm-plain+json",\n    "type": "http://example.com/protocols/lets_do_lunch/1.0/proposal"\n}',
  INVALID_PLAINTEXT_MSG_WRONG_TYP:
    '{\n    "id": "1234567890",\n    "typ": "application/didcomm-plain+json-unknown",\n    "type": "http://example.com/protocols/lets_do_lunch/1.0/proposal",\n    "body": {}\n}',
  INVALID_PLAINTEXT_MSG_EMPTY_ATTACHMENTS:
    '{\n    "id": "1234567890",\n    "typ": "application/didcomm-plain+json",\n    "type": "http://example.com/protocols/lets_do_lunch/1.0/proposal",\n    "body": {},\n    "attachments": [{}]\n}',
  INVALID_PLAINTEXT_MSG_ATTACHMENTS_NO_DATA:
    '{\n    "id": "1234567890",\n    "typ": "application/didcomm-plain+json",\n    "type": "http://example.com/protocols/lets_do_lunch/1.0/proposal",\n    "body": {},\n    "attachments": [{"id": "23"}]\n}',
  INVALID_PLAINTEXT_MSG_ATTACHMENTS_EMPTY_DATA:
    '{\n    "id": "1234567890",\n    "typ": "application/didcomm-plain+json",\n    "type": "http://example.com/protocols/lets_do_lunch/1.0/proposal",\n    "body": {},\n    "attachments": [{"id": "23", "data": {}}]\n}',
  INVALID_PLAINTEXT_MSG_ATTACHMENTS_LINKS_NO_HASH:
    '{\n    "id": "1234567890",\n    "typ": "application/didcomm-plain+json",\n    "type": "http://example.com/protocols/lets_do_lunch/1.0/proposal",\n    "body": {},\n    "attachments": [{"id": "23", "data": {"links": ["231", "212"]}}]\n}',
  INVALID_PLAINTEXT_MSG_ATTACHMENTS_AS_STRING:
    '{\n    "id": "1234567890",\n    "typ": "application/didcomm-plain+json",\n    "type": "http://example.com/protocols/lets_do_lunch/1.0/proposal",\n    "body": {},\n    "attachments": "131"\n}',
  INVALID_PLAINTEXT_MSG_ATTACHMENTS_AS_INT_ARRAY:
    '{\n    "id": "1234567890",\n    "typ": "application/didcomm-plain+json",\n    "type": "http://example.com/protocols/lets_do_lunch/1.0/proposal",\n    "body": {},\n    "attachments": [2131]\n}',
  INVALID_PLAINTEXT_MSG_ATTACHMENTS_WRONG_DATA:
    '{\n    "id": "1234567890",\n    "typ": "application/didcomm-plain+json",\n    "type": "http://example.com/protocols/lets_do_lunch/1.0/proposal",\n    "body": {},\n    "attachments": [{"id": "1", "data": "invalid"}]\n}',
  INVALID_PLAINTEXT_MSG_ATTACHMENTS_WRONG_ID:
    '{\n    "id": "1234567890",\n    "typ": "application/didcomm-plain+json",\n    "type": "http://example.com/protocols/lets_do_lunch/1.0/proposal",\n    "body": {},\n    "attachments": [{"id": 2}]\n}',
  INVALID_PLAINTEXT_MSG_ATTACHMENTS_NULL_DATA:
    '{\n    "id": "1234567890",\n    "typ": "application/didcomm-plain+json",\n    "type": "http://example.com/protocols/lets_do_lunch/1.0/proposal",\n    "body": {},\n    "attachments": [{"id": "1", "data": null}]\n}',
};

export const RUST_FROM_PRIOR_JWT: Record<string, string> = {
  FROM_PRIOR_JWT_FULL:
    'eyJ0eXAiOiJKV1QiLCJhbGciOiJFZERTQSIsImtpZCI6ImRpZDpleGFtcGxlOmNoYXJsaWUja2V5LTEifQ.eyJpc3MiOiJkaWQ6ZXhhbXBsZTpjaGFybGllIiwic3ViIjoiZGlkOmV4YW1wbGU6YWxpY2UiLCJhdWQiOiIxMjMiLCJleHAiOjEyMzQsIm5iZiI6MTIzNDUsImlhdCI6MTIzNDU2LCJqdGkiOiJkZmcifQ.ir0tegXiGJIZIMagO5P853KwhzGTEw0OpFFAyarUV-nQrtbI_ELbxT9l7jPBoPve_-60ifGJ9v3ArmFjELFlDA',
  FROM_PRIOR_JWT_INVALID: 'invalid',
  FROM_PRIOR_JWT_INVALID_SIGNATURE:
    'eyJ0eXAiOiJKV1QiLCJhbGciOiJFZERTQSIsImtpZCI6ImRpZDpleGFtcGxlOmNoYXJsaWUja2V5LTEifQ.eyJpc3MiOiJkaWQ6ZXhhbXBsZTpjaGFybGllIiwic3ViIjoiZGlkOmV4YW1wbGU6YWxpY2UiLCJhdWQiOiIxMjMiLCJleHAiOjEyMzQsIm5iZiI6MTIzNDUsImlhdCI6MTIzNDU2LCJqdGkiOiJkZmcifQ.ir0tegXiGJIZIMagO5P853KwhzGTEw0OpFFAyarUV-nQrtbI_ELbxT9l7jPBoPve_-60ifGJ9v3ArmFjELFlDB',
};
