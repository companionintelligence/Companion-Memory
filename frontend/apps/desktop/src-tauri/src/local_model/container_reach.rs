//! Linux: checks from inside the appliance that its containers reach the
//! Ollama they are set up to use, and says what to do when they do not.
//!
//! The containers call `host.docker.internal:11434`, which native Docker
//! Engine resolves to the docker bridge gateway (172.17.0.1, say). This app
//! cannot learn from the host whether those calls get through. A request from
//! this host to its own gateway address travels over loopback, and a host
//! firewall always lets loopback through. The containers' packets arrive on a
//! compose bridge instead and go through the firewall's incoming rules. With
//! ufw on and its default incoming policy (DROP), the app's own check passed
//! while every model call from the api timed out, and nothing said why.
//!
//! So once the stack is up, the app runs curl inside the api container against
//! the same address the api uses and logs what came back: reachable, timed out
//! (a firewall drops the connections), refused (nothing listens where the
//! containers arrive) or another error. The app never changes the firewall.
//! When ufw is on and its configuration is readable without root, the warning
//! names the rule to add.
//!
//! Compiled everywhere, like bridge_relay, so its tests run on every leg of
//! `desktop-build.yml`. Only the Linux path records a check: Docker Desktop on
//! macOS and Windows tunnels `host.docker.internal` to the host's loopback.

#![cfg_attr(not(target_os = "linux"), allow(dead_code))]

use std::io::Read;
use std::net::Ipv4Addr;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use super::bridge_relay::Ipv4Subnet;

/// How long curl may take for the whole request. A firewall that drops packets
/// gives no answer at all, so this is what a drop looks like.
const CURL_MAX_SECONDS: u64 = 5;

/// How long `docker exec` may run in all before it is killed: curl's own limit
/// plus Docker's start-up.
const EXEC_TIMEOUT: Duration = Duration::from_secs(20);

/// The range Docker's default address pools hand compose networks from
/// (172.17.0.0/16 to 172.31.0.0/16).
const DOCKER_ADDRESS_POOL: Ipv4Subnet = Ipv4Subnet {
    network: Ipv4Addr::new(172, 16, 0, 0),
    prefix_len: 12,
};

/// Where the containers' model calls go on this host.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Target {
    pub port: u16,
    /// The docker bridge gateway, where the containers arrive. None when Docker
    /// reported none (rootless Docker).
    pub gateway: Option<Ipv4Addr>,
    /// This app's relay listens on the gateway and forwards to an Ollama on
    /// 127.0.0.1.
    pub relayed: bool,
}

/// What the probe from inside the api container found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Reach {
    /// Ollama's `/api/version` answered with a success status.
    Reachable,
    /// No answer within CURL_MAX_SECONDS: the connection is being dropped.
    TimedOut,
    /// curl could not connect (its exit code 7). `detail` is what curl said.
    Refused { detail: String },
    /// Something answered, with this status instead of Ollama's version.
    HttpStatus(u16),
    /// The api container is not running yet. The check waits for the next start.
    ContainerNotRunning,
    /// curl could not be run in the api container.
    NoCurl { detail: String },
    /// Any other failure, with what curl or Docker said.
    Failed { detail: String },
}

impl Reach {
    /// A firewall on this computer may be the cause, so the message names the
    /// rule to add. A refused connection counts only when ufw rejects rather
    /// than drops (see firewall_advice).
    fn may_be_firewall(&self) -> bool {
        matches!(self, Reach::TimedOut | Reach::Refused { .. })
    }
}

/// The api container of the appliance's compose project.
fn api_container() -> String {
    format!("{}-api-1", crate::stack_manager::PROJECT_NAME)
}

/// The `docker` arguments of the probe. No shell, so nothing is quoted.
/// `--noproxy` because the api calls Ollama directly, whatever proxy the image
/// sets. `-w` prints the HTTP status on stdout; `-sS` keeps curl's own error
/// on stderr.
fn probe_args(container: &str, port: u16) -> Vec<String> {
    let max_seconds = CURL_MAX_SECONDS.to_string();
    let url = format!("http://host.docker.internal:{port}/api/version");
    [
        "exec",
        container,
        "curl",
        "--noproxy",
        "*",
        "-sS",
        "-o",
        "/dev/null",
        "-m",
        &max_seconds,
        "-w",
        "%{http_code}",
        &url,
    ]
    .iter()
    .map(|arg| arg.to_string())
    .collect()
}

/// Docker's own refusal to exec, as opposed to anything curl said.
fn container_not_running(said: &str) -> bool {
    [
        "No such container",
        "is not running",
        "is restarting",
        "is paused",
    ]
    .iter()
    .any(|needle| said.contains(needle))
}

/// What went wrong, in the words of whoever said it. curl writes its error to
/// stderr and only the HTTP status (`000` when there was none) to stdout.
/// Docker 29 writes a failed exec ("executable file not found") to stdout when
/// stdout is a pipe, as it is here.
fn error_text(stdout: &str, stderr: &str) -> String {
    let (stdout, stderr) = (stdout.trim(), stderr.trim());
    if !stderr.is_empty() {
        stderr.to_string()
    } else if stdout.chars().all(|c| c.is_ascii_digit()) {
        String::new()
    } else {
        stdout.to_string()
    }
}

/// Reads the outcome of `docker exec … curl …`. `exit_code` is None when the
/// process was ended by a signal.
///
/// `docker exec` passes curl's exit code through. Docker itself exits 1 when it
/// cannot exec at all, and 126 or 127 when the program cannot be run (127 for
/// one that is not in the image on Docker 29). curl never uses those.
fn classify(exit_code: Option<i32>, stdout: &str, stderr: &str) -> Reach {
    let detail = error_text(stdout, stderr);

    match exit_code {
        Some(0) => match stdout.trim().parse::<u16>() {
            Ok(status) if (200..300).contains(&status) => Reach::Reachable,
            Ok(status) => Reach::HttpStatus(status),
            Err(_) => Reach::Failed {
                detail: format!("curl printed no HTTP status (stdout: {:?})", stdout.trim()),
            },
        },
        Some(7) => Reach::Refused { detail },
        Some(28) => Reach::TimedOut,
        Some(126 | 127) => Reach::NoCurl { detail },
        _ if container_not_running(&detail) => Reach::ContainerNotRunning,
        Some(code) if detail.is_empty() => Reach::Failed {
            detail: format!("the probe exited with code {code}"),
        },
        Some(_) => Reach::Failed { detail },
        None => Reach::Failed {
            detail: "`docker exec` was ended by a signal".to_string(),
        },
    }
}

/// Runs `command` with its output captured, killing it after `timeout`.
/// Returns the exit code (None for a signal), stdout and stderr.
fn run_with_timeout(
    mut command: Command,
    timeout: Duration,
) -> Result<(Option<i32>, String, String), String> {
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("could not run docker: {e}"))?;
    let deadline = Instant::now() + timeout;

    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!(
                    "`docker exec` did not finish within {}s",
                    timeout.as_secs()
                ));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(100)),
            Err(e) => return Err(format!("could not wait for docker: {e}")),
        }
    };

    // The probe prints a few bytes, far below a pipe's buffer, so reading after
    // the exit cannot have blocked the child.
    let mut stdout = String::new();
    let mut stderr = String::new();
    if let Some(mut out) = child.stdout.take() {
        let _ = out.read_to_string(&mut stdout);
    }
    if let Some(mut err) = child.stderr.take() {
        let _ = err.read_to_string(&mut stderr);
    }

    Ok((status.code(), stdout, stderr))
}

/// Runs the probe in the appliance's api container.
fn probe_api_container(port: u16) -> Reach {
    let mut command = crate::stack_manager::docker_command();
    command.args(probe_args(&api_container(), port));

    match run_with_timeout(command, EXEC_TIMEOUT) {
        Ok((exit_code, stdout, stderr)) => classify(exit_code, &stdout, &stderr),
        Err(detail) => Reach::Failed { detail },
    }
}

/// What ufw's own configuration says. `ufw status` needs root, but ufw starts
/// from these two files and both are readable by anyone.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Ufw {
    /// `ENABLED=yes` in /etc/ufw/ufw.conf.
    enabled: bool,
    /// `DEFAULT_INPUT_POLICY="REJECT"` in /etc/default/ufw. A rejected
    /// connection reads as refused rather than timed out.
    rejects: bool,
}

/// The value of `KEY=value` in a shell-style config file, unquoted.
fn config_value<'a>(contents: &'a str, key: &str) -> Option<&'a str> {
    contents.lines().find_map(|line| {
        let (name, value) = line.trim().split_once('=')?;
        (name.trim() == key).then(|| value.trim().trim_matches(|c| c == '"' || c == '\''))
    })
}

fn parse_ufw(conf: &str, defaults: Option<&str>) -> Ufw {
    let enabled =
        config_value(conf, "ENABLED").is_some_and(|value| value.eq_ignore_ascii_case("yes"));
    let rejects = defaults
        .and_then(|defaults| config_value(defaults, "DEFAULT_INPUT_POLICY"))
        .is_some_and(|policy| policy.eq_ignore_ascii_case("REJECT"));

    Ufw { enabled, rejects }
}

/// None when ufw is not installed or its configuration cannot be read.
fn read_ufw() -> Option<Ufw> {
    let conf = std::fs::read_to_string("/etc/ufw/ufw.conf").ok()?;
    let defaults = std::fs::read_to_string("/etc/default/ufw").ok();

    Some(parse_ufw(&conf, defaults.as_deref()))
}

/// The source ranges to allow: Docker's default pool, which covers every
/// compose network it hands out unless the daemon is set up otherwise, plus
/// any appliance network outside it, as it is. The pool alone when the
/// networks could not be read.
fn allow_ranges(appliance_subnets: &[Ipv4Subnet]) -> Vec<String> {
    let mut ranges = Vec::new();
    if appliance_subnets.is_empty()
        || appliance_subnets
            .iter()
            .any(|subnet| DOCKER_ADDRESS_POOL.covers(subnet))
    {
        ranges.push(DOCKER_ADDRESS_POOL.to_string());
    }
    for subnet in appliance_subnets
        .iter()
        .filter(|subnet| !DOCKER_ADDRESS_POOL.covers(subnet))
    {
        let range = subnet.to_string();
        if !ranges.contains(&range) {
            ranges.push(range);
        }
    }
    ranges
}

fn ufw_allow_command(range: &str, port: u16) -> String {
    format!("sudo ufw allow from {range} to any port {port} proto tcp")
}

/// What to tell the person about the firewall, or None when it is unlikely to
/// be the cause. A refused connection is ufw's doing only when ufw rejects.
fn firewall_advice(
    reach: &Reach,
    ufw: Option<Ufw>,
    ranges: &[String],
    port: u16,
) -> Option<String> {
    let ufw_on = ufw.is_some_and(|ufw| ufw.enabled);
    let ufw_rejects = ufw.is_some_and(|ufw| ufw.enabled && ufw.rejects);
    let commands = ranges
        .iter()
        .map(|range| ufw_allow_command(range, port))
        .collect::<Vec<_>>()
        .join("` and `");

    match reach {
        Reach::TimedOut if ufw_on => Some(format!(
            "ufw is on. Allow the appliance's networks with `{commands}`."
        )),
        Reach::TimedOut => Some(format!(
            "Allow incoming TCP connections to port {port} from the appliance's docker networks ({}) in this \
             computer's firewall.",
            ranges.join(", ")
        )),
        Reach::Refused { .. } if ufw_rejects => Some(format!(
            "ufw is on and rejects connections it does not allow, which also looks like this. If Ollama is \
             running, allow the appliance's networks with `{commands}`."
        )),
        _ => None,
    }
}

/// Where the containers' calls go, in words: the address they use and, when
/// known, the one they arrive at on this host.
fn describe_target(target: &Target) -> String {
    let port = target.port;
    let relay = if target.relayed {
        format!(", this app's relay to 127.0.0.1:{port}")
    } else {
        String::new()
    };

    match target.gateway {
        Some(gateway) => {
            format!("host.docker.internal:{port} ({gateway}:{port} on this computer{relay})")
        }
        None => format!("host.docker.internal:{port}"),
    }
}

/// The log line for what the probe found, and how loud it is.
fn describe(reach: &Reach, target: &Target, advice: Option<&str>) -> (log::Level, String) {
    let at = describe_target(target);
    let with_advice = |message: String| match advice {
        Some(advice) => format!("{message} {advice}"),
        None => message,
    };

    match reach {
        Reach::Reachable => (
            log::Level::Info,
            format!("Checked from inside the api container: the appliance's containers reach Ollama at {at}."),
        ),
        Reach::TimedOut => (
            log::Level::Warn,
            with_advice(format!(
                "The appliance's containers cannot reach Ollama. From inside the api container, {at} did not \
                 answer within {CURL_MAX_SECONDS} seconds, so their connections to port {} are being dropped, \
                 most likely by a firewall on this computer. Chat, search and summaries fail until that port is \
                 allowed.",
                target.port
            )),
        ),
        Reach::Refused { detail } => {
            let next = if target.relayed {
                "This app's relay was started there; look for a relay error earlier in this log."
            } else {
                "Check that your Ollama is still running."
            };
            (
                log::Level::Warn,
                with_advice(format!(
                    "The appliance's containers cannot reach Ollama. From inside the api container, the \
                     connection to {at} was refused, so nothing is listening there for them ({detail}). {next}"
                )),
            )
        }
        Reach::HttpStatus(status) => (
            log::Level::Warn,
            format!(
                "From inside the api container, {at} answered HTTP {status} to Ollama's /api/version, so the \
                 appliance's containers reach something there that is not Ollama."
            ),
        ),
        Reach::ContainerNotRunning => (
            log::Level::Debug,
            "The api container is not running yet; the check that it reaches Ollama waits for the next start."
                .to_string(),
        ),
        Reach::NoCurl { detail } => (
            log::Level::Warn,
            format!(
                "Could not check from inside the appliance whether its containers reach Ollama at {at}: curl \
                 could not be run in the api container ({detail})."
            ),
        ),
        Reach::Failed { detail } => (
            log::Level::Warn,
            format!("Could not confirm that the appliance's containers reach Ollama at {at}: {detail}"),
        ),
    }
}

/// Probes from the api container and logs what it found. False when the api
/// container was not running, so the caller keeps the check for the next start.
pub(super) fn check_and_log(target: &Target) -> bool {
    let reach = probe_api_container(target.port);
    if reach == Reach::ContainerNotRunning {
        let (level, message) = describe(&reach, target, None);
        log::log!(level, "{message}");
        return false;
    }

    // Asked only when the firewall may be the cause: each read spawns docker.
    let advice = if reach.may_be_firewall() {
        let ranges = allow_ranges(&super::bridge_relay::discover_appliance_subnets());
        firewall_advice(&reach, read_ufw(), &ranges, target.port)
    } else {
        None
    };

    let (level, message) = describe(&reach, target, advice.as_deref());
    log::log!(level, "{message}");
    true
}

#[cfg(test)]
mod tests {
    use super::super::bridge_relay::parse_subnets;
    use super::*;

    const TIMED_OUT: &str = "curl: (28) Connection timed out after 5002 milliseconds";
    const REFUSED: &str =
        "curl: (7) Failed to connect to host.docker.internal port 11434 after 0 ms: Could not connect to server";

    fn gateway_target(relayed: bool) -> Target {
        Target {
            port: 11434,
            gateway: Some(Ipv4Addr::new(172, 17, 0, 1)),
            relayed,
        }
    }

    /// The exact command the app runs, so a reviewer can run the same one by
    /// hand: `docker exec ci-server-desktop-api-1 curl …`.
    #[test]
    fn the_probe_runs_curl_in_the_api_container_against_the_address_the_api_uses() {
        assert_eq!(api_container(), "ci-server-desktop-api-1");
        assert_eq!(
            probe_args("ci-server-desktop-api-1", 11434).join(" "),
            "exec ci-server-desktop-api-1 curl --noproxy * -sS -o /dev/null -m 5 -w %{http_code} \
             http://host.docker.internal:11434/api/version"
        );
    }

    /// curl's exit codes as `docker exec` passes them through, with the output
    /// a real run printed (curl 8.14 in the 2026.11.19 api image).
    #[test]
    fn curls_exit_code_and_status_decide_the_outcome() {
        assert_eq!(classify(Some(0), "200", ""), Reach::Reachable);
        assert_eq!(classify(Some(0), "204\n", ""), Reach::Reachable);
        assert_eq!(classify(Some(28), "000", TIMED_OUT), Reach::TimedOut);
        assert_eq!(
            classify(Some(7), "000", REFUSED),
            Reach::Refused {
                detail: REFUSED.to_string()
            }
        );
    }

    /// Without `-f`, curl exits 0 for any HTTP status. Only a success is Ollama
    /// answering its version.
    #[test]
    fn an_answer_that_is_not_a_success_is_not_ollama() {
        assert_eq!(classify(Some(0), "404", ""), Reach::HttpStatus(404));
        assert_eq!(classify(Some(0), "502", ""), Reach::HttpStatus(502));
        assert!(matches!(classify(Some(0), "", ""), Reach::Failed { .. }));
    }

    /// The image may lack curl one day. That is a check that could not run,
    /// never a crash and never "unreachable". Docker 29 exits 127; older
    /// releases exit 126.
    #[test]
    fn a_missing_curl_is_reported_as_a_check_that_could_not_run() {
        let missing = "OCI runtime exec failed: exec failed: unable to start container process: exec: \"curl\": \
                       executable file not found in $PATH";
        let expected = Reach::NoCurl {
            detail: missing.to_string(),
        };
        // Docker 29 with stdout piped, as the app runs it: the error is on stdout.
        assert_eq!(classify(Some(127), &format!("{missing}\r\n"), ""), expected);
        assert_eq!(classify(Some(126), "", missing), expected);
    }

    /// Docker's own errors. A container that is not up yet is checked again
    /// at the next start. Anything else is reported with Docker's words.
    #[test]
    fn dockers_own_errors_are_told_apart() {
        let stopped = "Error response from daemon: container e7d6b482c16d is not running";
        let missing = "Error response from daemon: No such container: ci-server-desktop-api-1";
        let restarting = "Error response from daemon: Container 1f2e is restarting, wait until the container is running";
        assert_eq!(classify(Some(1), "", stopped), Reach::ContainerNotRunning);
        assert_eq!(classify(Some(1), "", missing), Reach::ContainerNotRunning);
        assert_eq!(
            classify(Some(1), "", restarting),
            Reach::ContainerNotRunning
        );

        let daemon_down =
            "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?";
        assert_eq!(
            classify(Some(1), "", daemon_down),
            Reach::Failed {
                detail: daemon_down.to_string()
            }
        );

        let unresolved = "curl: (6) Could not resolve host: host.docker.internal";
        assert_eq!(
            classify(Some(6), "000", unresolved),
            Reach::Failed {
                detail: unresolved.to_string()
            }
        );
        assert!(
            matches!(classify(Some(52), "000", ""), Reach::Failed { detail } if detail.contains("52"))
        );
        assert!(matches!(classify(None, "", ""), Reach::Failed { .. }));
    }

    #[cfg(unix)]
    #[test]
    fn a_command_is_read_when_it_ends_and_killed_when_it_does_not() {
        let mut quick = Command::new("sh");
        quick.args(["-c", "printf 000; echo 'curl: (28) timed out' >&2; exit 28"]);
        let (code, stdout, stderr) =
            run_with_timeout(quick, Duration::from_secs(5)).expect("sh runs");
        assert_eq!(code, Some(28));
        assert_eq!(stdout, "000");
        assert_eq!(stderr.trim(), "curl: (28) timed out");

        let mut hung = Command::new("sleep");
        hung.arg("30");
        let started = Instant::now();
        let err =
            run_with_timeout(hung, Duration::from_millis(300)).expect_err("killed at the deadline");
        assert!(err.contains("did not finish"), "unexpected error: {err}");
        assert!(started.elapsed() < Duration::from_secs(5));

        let err = run_with_timeout(Command::new("/nonexistent/docker"), Duration::from_secs(1))
            .expect_err("a missing program is an error, not a panic");
        assert!(
            err.contains("could not run docker"),
            "unexpected error: {err}"
        );
    }

    /// Ubuntu's own files, as ufw writes them.
    #[test]
    fn ufws_state_is_read_from_its_own_configuration() {
        let enabled = "# /etc/ufw/ufw.conf\n#\n\n# Set to yes to start on boot.\nENABLED=yes\n\nLOGLEVEL=low\n";
        let disabled = "ENABLED=no\nLOGLEVEL=low\n";
        let drop = "IPV6=yes\nDEFAULT_INPUT_POLICY=\"DROP\"\nDEFAULT_OUTPUT_POLICY=\"ACCEPT\"\n";
        let reject = "DEFAULT_INPUT_POLICY=\"REJECT\"\n";

        assert_eq!(
            parse_ufw(enabled, Some(drop)),
            Ufw {
                enabled: true,
                rejects: false
            }
        );
        assert_eq!(
            parse_ufw(enabled, Some(reject)),
            Ufw {
                enabled: true,
                rejects: true
            }
        );
        assert_eq!(
            parse_ufw(disabled, Some(drop)),
            Ufw {
                enabled: false,
                rejects: false
            }
        );
        assert_eq!(
            parse_ufw(enabled, None),
            Ufw {
                enabled: true,
                rejects: false
            }
        );
        assert_eq!(
            parse_ufw("", None),
            Ufw {
                enabled: false,
                rejects: false
            }
        );
    }

    /// 172.16.0.0/12 covers every network Docker's default pools hand out. A
    /// compose network outside it (a daemon with its own `default-address-pools`)
    /// is named as it is, or the rule would not match its traffic.
    #[test]
    fn the_rule_names_dockers_pool_or_the_appliances_own_range() {
        assert_eq!(
            allow_ranges(&parse_subnets("172.18.0.0/16")),
            vec!["172.16.0.0/12"]
        );
        assert_eq!(
            allow_ranges(&parse_subnets("172.31.0.0/16 172.22.0.0/16")),
            vec!["172.16.0.0/12"]
        );
        assert_eq!(
            allow_ranges(&[]),
            vec!["172.16.0.0/12"],
            "networks unknown: Docker's default"
        );
        assert_eq!(
            allow_ranges(&parse_subnets("192.168.32.0/20")),
            vec!["192.168.32.0/20"]
        );
        assert_eq!(
            allow_ranges(&parse_subnets("10.10.0.0/24 10.10.0.0/24")),
            vec!["10.10.0.0/24"]
        );
        assert_eq!(
            allow_ranges(&parse_subnets("172.18.0.0/16 10.10.0.0/24")),
            vec!["172.16.0.0/12", "10.10.0.0/24"]
        );
        // Next to the pool but outside it.
        assert_eq!(
            allow_ranges(&parse_subnets("172.32.0.0/16")),
            vec!["172.32.0.0/16"]
        );
    }

    /// The reported case: ufw on with its default DROP policy, the user's
    /// Ollama on *:11434 and the containers timing out.
    #[test]
    fn a_timeout_with_ufw_on_names_the_exact_rule() {
        let ranges = allow_ranges(&parse_subnets("172.18.0.0/16"));
        let ufw = Some(Ufw {
            enabled: true,
            rejects: false,
        });
        let advice = firewall_advice(&Reach::TimedOut, ufw, &ranges, 11434).expect("advice");
        let (level, message) = describe(&Reach::TimedOut, &gateway_target(false), Some(&advice));

        assert_eq!(level, log::Level::Warn);
        assert!(
            message.contains("`sudo ufw allow from 172.16.0.0/12 to any port 11434 proto tcp`"),
            "{message}"
        );
        assert!(
            message.contains("172.17.0.1:11434 on this computer"),
            "{message}"
        );
        assert!(
            message.contains("most likely by a firewall on this computer"),
            "{message}"
        );
    }

    #[test]
    fn a_timeout_without_ufw_names_the_port_and_range_but_no_command() {
        let ranges = allow_ranges(&parse_subnets("192.168.32.0/20"));
        for ufw in [
            None,
            Some(Ufw {
                enabled: false,
                rejects: false,
            }),
        ] {
            let advice = firewall_advice(&Reach::TimedOut, ufw, &ranges, 11434).expect("advice");
            assert!(!advice.contains("sudo"), "{advice}");
            assert!(advice.contains("port 11434"), "{advice}");
            assert!(advice.contains("192.168.32.0/20"), "{advice}");
        }
    }

    /// With ufw's DROP policy a refused connection is not ufw's doing, so the
    /// rule is offered only when ufw rejects.
    #[test]
    fn a_refused_connection_blames_the_firewall_only_when_ufw_rejects() {
        let refused = Reach::Refused {
            detail: REFUSED.to_string(),
        };
        let ranges = vec!["172.16.0.0/12".to_string()];

        assert_eq!(
            firewall_advice(
                &refused,
                Some(Ufw {
                    enabled: true,
                    rejects: false
                }),
                &ranges,
                11434
            ),
            None
        );
        assert_eq!(firewall_advice(&refused, None, &ranges, 11434), None);
        let advice = firewall_advice(
            &refused,
            Some(Ufw {
                enabled: true,
                rejects: true,
            }),
            &ranges,
            11434,
        )
        .expect("ufw rejects");
        assert!(
            advice.contains("sudo ufw allow from 172.16.0.0/12 to any port 11434 proto tcp"),
            "{advice}"
        );

        let (level, message) = describe(&refused, &gateway_target(true), None);
        assert_eq!(level, log::Level::Warn);
        assert!(message.contains("nothing is listening there"), "{message}");
        assert!(message.contains("relay"), "{message}");
        assert!(
            message.contains("Could not connect to server"),
            "curl's own words: {message}"
        );
        let (_, own_ollama) = describe(&refused, &gateway_target(false), None);
        assert!(
            own_ollama.contains("Check that your Ollama is still running"),
            "{own_ollama}"
        );
    }

    /// A good result says where it was checked from: the line the old host-side
    /// check printed claimed the same thing without having looked.
    #[test]
    fn a_reachable_result_says_it_was_checked_from_the_containers() {
        let (level, message) = describe(&Reach::Reachable, &gateway_target(true), None);
        assert_eq!(level, log::Level::Info);
        assert!(
            message.starts_with("Checked from inside the api container"),
            "{message}"
        );
        assert!(
            message.contains("this app's relay to 127.0.0.1:11434"),
            "{message}"
        );

        let rootless = Target {
            port: 11434,
            gateway: None,
            relayed: false,
        };
        let (_, message) = describe(&Reach::Reachable, &rootless, None);
        assert!(
            message.ends_with("reach Ollama at host.docker.internal:11434."),
            "{message}"
        );
    }

    #[test]
    fn other_outcomes_are_warnings_with_their_cause() {
        let target = gateway_target(false);
        for (reach, needle) in [
            (Reach::HttpStatus(404), "HTTP 404"),
            (
                Reach::NoCurl {
                    detail: "exec: \"curl\": executable file not found".to_string(),
                },
                "curl could not be run",
            ),
            (
                Reach::Failed {
                    detail: "curl: (6) Could not resolve host".to_string(),
                },
                "Could not resolve host",
            ),
        ] {
            let (level, message) = describe(&reach, &target, None);
            assert_eq!(level, log::Level::Warn, "{message}");
            assert!(message.contains(needle), "{message}");
        }
        assert_eq!(
            describe(&Reach::ContainerNotRunning, &target, None).0,
            log::Level::Debug
        );
    }
}
