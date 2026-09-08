# Set up Companion Memory

> **Private & Confidential — Property of Lifescope Inc. Do not distribute.**

This is the operational setup guide for a Companion Memory appliance. It is the
current contract between CI-Portal, CI-Hub, and CI-Server; the older
[Hub-inference integration design](../architecture/hub-inference-integration.md)
is retained for its design history, not as a runbook.

## Pick the setup path

| Your installation                | Who manages inference                                               | What to do in Memory                                                                                                        |
| -------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Installed and managed by CI-Hub  | CI-Hub chooses the inference backend, endpoint, and model lifecycle | Confirm the endpoint in **Settings → Model**, then run a connection check. Do not replace a Hub-managed endpoint in Memory. |
| A direct CI-Server appliance     | The appliance owner                                                 | Choose Ollama or an OpenAI-compatible backend, save its port, test it from Memory, then choose an active model.             |
| Remote OpenAI-compatible service | The appliance owner / deployment                                    | Configure its reachable port and write-only credential. The API container — not the browser — must be able to reach it.     |

The two planes are intentionally separate:

- **CI-Portal** owns the person, organization, device registration, and Hub
  pairing record.
- **CI-Hub** owns the installed-app runtime and, when it manages inference,
  injects the app's inference configuration.
- **CI-Server / Companion Memory** owns memory data, its own session/API-key
  access, model selection, and the final connection check from its API process.

That split avoids a common first-run mistake: a backend reachable at the host's
`localhost` may still be unreachable from the API container that actually runs
Memory.

## Recommended first run

1. Create or sign in to your Companion Account in CI-Portal and create or join
   the organization that will own the appliance.
2. Register and pair the device in CI-Portal. Pairing gives CI-Hub the
   organization context it needs to install and route first-party apps.
3. Install or open Companion Memory from CI-Hub. If Hub provides inference, let
   it inject the endpoint rather than duplicating that configuration inside
   Memory.
4. In Memory, open **Settings → Model**. The endpoint card says whether it is
   Hub/host managed or stored on this appliance, and always displays the safe
   endpoint used by the API container.
5. Select **Test connection**. A successful check includes the models reported
   by the backend. A successful TCP connection with zero models is not ready for
   chat; install or expose a model first.
6. Select an active chat model and set its tools, thinking, and image-description
   preferences. Keep image description off unless the selected model supports
   vision.

For Hub-mediated sign-in and agent authorization, CI-Server also needs its
normal application identity setup: a reachable `CI_SERVER_URL`, a valid
scoped API key for the connection flow, and Portal sign-in/consent. An endpoint
check proves inference reachability only; it does not prove that identity or
consent is configured.

## Configure a direct appliance

Use **Settings → Model** for the guided path:

1. Choose **Ollama** (normally port `11434`) or **OpenAI-compatible** (normally
   port `8000`).
2. For an OpenAI-compatible backend, enter a credential only when that backend
   requires one. A saved credential is write-only: the UI shows that one exists
   but never reads it back into the browser.
3. Save the endpoint, then run **Test connection** before selecting a model.

The host/gateway is deployment-owned so the same appliance configuration works
in a containerized installation. The Settings screen changes the backend type
and port, not an arbitrary hostname. If the check cannot reach your backend,
fix the appliance's host gateway or container network exposure rather than
pointing the browser at a different `localhost`.

### Command-line equivalent

`ci` is the appliance CLI (`ci-import` still works as a deprecated alias). It
uses the **Memory API key** to authenticate to CI-Server, while
`--backend-api-key` is the separate, write-only credential for the inference
backend.

```bash
export CI_SERVER_URL=http://localhost:3030
export CI_API_KEY='memory-api-key'

ci memory status
ci memory configure --backend ollama --port 11434
ci memory check

# For a local vLLM or another OpenAI-compatible service:
ci memory configure \
  --backend openai-compatible \
  --port 8000 \
  --backend-api-key 'backend-token'
ci memory check
```

`memory status` shows the endpoint, backend, management mode, and whether a
credential is available — never the credential itself. `memory check` exits
non-zero when the API process cannot reach the backend. `memory configure
--clear-api-key` removes a credential saved by the appliance and falls back to
any deployment-supplied default.

## Hub-managed inference

CI-Hub may provide `HUB_INFERENCE_URL` and map it into Memory's `LLM_*`
configuration. When the endpoint card says it is managed, the Memory API treats
it as read-only so an in-app or CLI change cannot accidentally detach the app
from Hub's selected backend.

Memory preserves the entire managed URL, including its scheme and any gateway
prefix such as `/api/inference/v1`, before it asks the backend for models or
opens a chat request.

Use this sequence instead:

1. Change the inference backend or selected Hub model in CI-Hub.
2. Let Hub update/restart the installed `ci-memory` app as appropriate.
3. In Memory, run **Test connection** or `ci memory check`.
4. Refresh the model selector and choose the chat model exposed by Hub.

CI-Hub owns downloads and resource scheduling for its managed backend. Memory
does not pull a model merely because it appears in an endpoint setting.

## Backends, roles, and safety

- Native **Ollama** is checked through `/api/tags`; an **OpenAI-compatible**
  backend is checked through `/v1/models` and uses a bearer credential only
  when one is configured.
- The check has a bounded timeout and refuses redirects. This prevents a saved
  credential from being sent to an unexpected redirected host.
- Backend credentials are stored with owner-only filesystem permissions when
  the appliance persists them. They are not included in `GET /llm/endpoint`,
  `PATCH /llm/endpoint`, UI state, or CLI status output.
- Chat-model selection and embedding-model selection are different concerns.
  The current search index is coupled to a 768-dimensional embedding model;
  validate an embedding change before applying it to an existing appliance.

## Troubleshooting

| Symptom                                      | Likely cause                                                                                 | Next action                                                                                       |
| -------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| The endpoint test cannot connect             | The backend is reachable from the host but not the API container, or its port is not exposed | Verify the deployment's host-gateway/container networking and run `ci memory check` again. |
| The test returns 401 or 403                  | The backend requires a credential, or a saved credential is wrong                            | Replace the backend credential in Settings or with `--backend-api-key`, then re-test.             |
| The test connects but reports no models      | The server is running but has no downloaded/exposed model                                    | Pull/expose a model in Ollama, vLLM, or CI-Hub, then re-test.                                     |
| The endpoint is locked                       | CI-Hub or host environment supplied the endpoint                                             | Change it in CI-Hub or the deployment configuration, not in Memory.                               |
| Hub can open but Memory cannot connect to it | The Hub/Memory identity path is incomplete                                                   | Verify `CI_SERVER_URL`, scoped API key, Portal sign-in, and consent separately from inference.    |

## API and CLI reference

- [REST LLM endpoints](../api/rest.md#llm--chat--llm--domainsllmcontrollersollamacontrollerts42--domainsllmcontrollersllmendpointcontrollerts15)
- [`ci` command reference](../cli/ci.md#memory-inference-setup)
- [Hub inference design history](../architecture/hub-inference-integration.md)
