"""
What the CI-Server Python sidecars (HBPE, Summary) share below their domains.

- :mod:`ci.sidecar.runner` — the ``POST /functions/run`` worker pool and its
  pg-boss completion callback; a service subclasses it with its API address.
- :mod:`ci.sidecar.auth` — the ``SIDECAR_AUTH_SECRET`` bearer middleware and
  the ``user_id`` validators.
- :mod:`ci.sidecar.llm_host` — correcting an LLM base URL for the network
  namespace the process is in.
- :mod:`ci.sidecar.timezone` — validating the IANA zone in ``ci.users.timezone``.
"""
