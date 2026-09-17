//! Makes a loopback-bound sidecar reachable from the compose containers
//! WITHOUT exposing it to the LAN. Only the Linux path calls it; see the note
//! at the end of this comment for why it still compiles everywhere.
//!
//! ## Why this exists
//!
//! `ollama_sidecar::spawn_serve` binds `127.0.0.1` on every platform. On
//! macOS/Windows that is all that is needed — Docker Desktop's VM tunnels
//! `host.docker.internal` back to the host's loopback. On NATIVE (rootful)
//! Docker Engine it is not: `host.docker.internal:host-gateway` resolves to the
//! docker BRIDGE GATEWAY address (typically `172.17.0.1`), so a container's
//! chat/embedding call arrives at the host on that interface and a
//! loopback-only server never sees it.
//!
//! The previous answer was to bind `0.0.0.0` on Linux. That is strictly worse
//! than it looks, because Ollama has no server-side auth on any route AND
//! binding non-loopback disables the one guard it does have —
//! `allowedHostsMiddleware` short-circuits for a non-loopback listen address.
//! Any LAN peer got unauthenticated `/api/generate`, `/api/chat`, `/api/embed`,
//! plus destructive `/api/delete` + `/api/create`; the last pair is a
//! model-substitution foothold, since `OllamaService::resolveServedChatModel`
//! falls back to "whatever model is served".
//!
//! So: bind the sidecar to loopback, and put a plain TCP relay on the ONE
//! address containers actually arrive from. The relay's listen socket is bound
//! to that single address — not `0.0.0.0` — so the kernel drops anything
//! arriving on the machine's real NICs before this process sees it.
//!
//! ## When the gateway cannot be discovered
//!
//! Under rootless Docker, `host-gateway` resolves inside RootlessKit's network
//! namespace rather than to a bridge gateway on the host (moby#47684), so
//! `docker network inspect bridge` may report no usable gateway. That is NOT a
//! reason to fall back to `0.0.0.0`: the caller stays loopback-only and logs
//! loudly. Rootless is also the configuration where a loopback bind has the
//! best chance of working unaided, because the container's traffic is forwarded
//! by slirp4netns from the host's own network namespace. If it still does not
//! work, the user gets a specific log line naming the command to run, rather
//! than a silently LAN-exposed GPU.
//!
//! Compiled on every platform even though only the Linux path calls it, so
//! these tests run on the macOS and Linux legs of `desktop-build.yml` alike —
//! the byte-pumping half is plain portable TCP and is the half worth testing.

#![cfg_attr(not(target_os = "linux"), allow(dead_code))]

use std::io::Read;
use std::net::{IpAddr, Ipv4Addr, Shutdown, SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::Duration;

/// How long a relayed connection waits to reach the loopback sidecar. Local
/// connect, so this only ever trips when the sidecar has died.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);

/// How long a relayed connection may go with no bytes moving in either
/// direction before it's torn down. This is a request/response protocol
/// (chat/embed calls), not a long-lived idle keepalive, so a genuinely stuck
/// peer — a container that opened a connection and never sent anything, or a
/// sidecar that stopped responding mid-stream — otherwise parks two OS
/// threads (see `relay_connection`) forever, since `shutdown()` deliberately
/// leaves in-flight connections to end on their own. Generous enough not to
/// cut off real token streaming (which keeps producing bytes well inside this
/// window) while still bounding the leak from a truly stalled peer.
const IDLE_TIMEOUT: Duration = Duration::from_secs(300);

#[derive(Debug)]
pub struct RelayHandle {
    /// The single address this relay listens on — the docker bridge gateway.
    pub bind_addr: SocketAddr,
    shutdown: Arc<AtomicBool>,
    accept_thread: Option<JoinHandle<()>>,
}

impl RelayHandle {
    /// Stops accepting and joins the accept thread.
    ///
    /// Connections already in flight are left to end on their own: their
    /// threads are detached and finish when either side closes. On app quit the
    /// sidecar they point at is killed moments later, which closes them.
    ///
    /// If the wake-up connect itself fails, this returns WITHOUT joining the
    /// accept thread, rather than blocking forever. `accept()` only observes
    /// the shutdown flag by accepting one more connection, so a failed wake-up
    /// (the bridge interface having been torn down and recreated with a
    /// different gateway while the app was running, e.g. Docker Desktop
    /// quitting or `docker network prune`) would otherwise hang this call —
    /// and everything downstream of it, including app quit — indefinitely.
    /// The accept thread is simply left running in that case; it costs one
    /// leaked thread + socket for the rest of the process's life rather than
    /// an unresponsive app.
    pub fn shutdown(mut self) {
        self.shutdown.store(true, Ordering::SeqCst);
        // `accept()` is blocking, so it will not observe the flag until one
        // more connection arrives. Be that connection.
        if let Err(e) = TcpStream::connect_timeout(&self.bind_addr, Duration::from_millis(500)) {
            log::warn!(
                "ollama bridge relay: could not wake its accept loop to shut it down cleanly ({e}); \
                 leaving it running rather than blocking on a join that may never return"
            );
            return;
        }
        if let Some(handle) = self.accept_thread.take() {
            let _ = handle.join();
        }
    }
}

/// Parses `docker network inspect bridge`'s gateway list.
///
/// Split from the command so the interesting half is testable on a host with no
/// Docker at all. Takes the first parseable IPv4 gateway: the default bridge
/// has exactly one IPv4 IPAM config, and an IPv6-only entry is not something a
/// `host-gateway` alias resolves to today.
fn parse_gateway(output: &str) -> Option<Ipv4Addr> {
    output.split_whitespace().find_map(|token| token.parse::<Ipv4Addr>().ok())
}

/// The address containers reach this host on, per the Docker daemon itself.
///
/// `host-gateway` is a single daemon-global value — moby's `setHostGatewayIP`
/// uses the DEFAULT bridge's IP — so containers on a user-defined compose
/// network still arrive from this same address. That is what makes a
/// single-address bind correct rather than a guess.
pub fn discover_host_gateway() -> Result<Ipv4Addr, String> {
    let output = crate::stack_manager::docker_command()
        .args(["network", "inspect", "bridge", "--format", "{{range .IPAM.Config}}{{.Gateway}} {{end}}"])
        .output()
        .map_err(|e| format!("could not run `docker network inspect bridge`: {e}"))?;

    if !output.status.success() {
        return Err(format!(
            "`docker network inspect bridge` failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }

    parse_gateway(&String::from_utf8_lossy(&output.stdout))
        .ok_or_else(|| "`docker network inspect bridge` reported no IPv4 gateway".to_string())
}

/// Listens on `bind_ip:port` and forwards every connection to
/// `127.0.0.1:port`.
///
/// Same port on both sides deliberately: containers reach the sidecar at
/// `host.docker.internal:11434`, which is the port `services.ollama.host`
/// already names, so nothing downstream needs an override.
pub fn spawn(bind_ip: Ipv4Addr, port: u16) -> Result<RelayHandle, String> {
    let requested = SocketAddr::new(IpAddr::V4(bind_ip), port);
    let listener =
        TcpListener::bind(requested).map_err(|e| format!("could not listen on {requested}: {e}"))?;
    // Read the address back rather than reusing `requested`: `shutdown` unblocks
    // `accept()` by connecting to it, which cannot work for a port-0 (ephemeral)
    // bind unless the real port is recorded here.
    let bind_addr = listener
        .local_addr()
        .map_err(|e| format!("could not read back the relay's own address: {e}"))?;

    let shutdown = Arc::new(AtomicBool::new(false));
    let accept_shutdown = Arc::clone(&shutdown);

    let accept_thread = std::thread::Builder::new()
        .name("ollama-bridge-relay".to_string())
        .spawn(move || {
            for stream in listener.incoming() {
                if accept_shutdown.load(Ordering::SeqCst) {
                    break;
                }
                match stream {
                    Ok(inbound) => {
                        std::thread::spawn(move || {
                            if let Err(e) = relay_connection(inbound, port) {
                                log::debug!("ollama bridge relay: connection ended: {e}");
                            }
                        });
                    }
                    // A single failed accept is not fatal (EMFILE, a peer that
                    // vanished mid-handshake); keep serving.
                    Err(e) => log::debug!("ollama bridge relay: accept failed: {e}"),
                }
            }
        })
        .map_err(|e| format!("could not start the relay thread: {e}"))?;

    Ok(RelayHandle { bind_addr, shutdown, accept_thread: Some(accept_thread) })
}

/// Pumps one accepted connection to the loopback sidecar and back.
fn relay_connection(inbound: TcpStream, port: u16) -> std::io::Result<()> {
    let target = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port);
    let outbound = TcpStream::connect_timeout(&target, CONNECT_TIMEOUT)?;

    // Nagle off on both halves: this is a request/response protocol, and the
    // extra round-trip latency shows up directly in token streaming.
    let _ = inbound.set_nodelay(true);
    let _ = outbound.set_nodelay(true);

    // Bounds how long either side may go with no bytes moving — see
    // IDLE_TIMEOUT's own comment. Applies to both reads and writes on both
    // sockets: a stalled peer can stop reading just as easily as stop
    // sending, and either one otherwise parks its half of this connection
    // forever, since `RelayHandle::shutdown` deliberately does not track or
    // interrupt in-flight connections.
    for stream in [&inbound, &outbound] {
        let _ = stream.set_read_timeout(Some(IDLE_TIMEOUT));
        let _ = stream.set_write_timeout(Some(IDLE_TIMEOUT));
    }

    let inbound_read = inbound.try_clone()?;
    let outbound_write = outbound.try_clone()?;

    // One direction on this thread, the other on a helper, so a half-close in
    // either direction is propagated rather than deadlocking the pair.
    let upstream = std::thread::spawn(move || pump(inbound_read, outbound_write));
    let downstream = pump(outbound, inbound);

    // Both directions are logged, not just the one this function returns:
    // a client->sidecar failure (upstream) is otherwise invisible — it never
    // surfaces here, and it may not even show up as a downstream error if the
    // sidecar had already sent a full response before the client side broke.
    match upstream.join() {
        Ok(Err(e)) => log::debug!("ollama bridge relay: upstream (client→sidecar) direction ended: {e}"),
        Err(_) => log::debug!("ollama bridge relay: upstream (client→sidecar) pump thread panicked"),
        Ok(Ok(())) => {}
    }

    downstream
}

/// Copies until EOF or the idle timeout trips, then half-closes the write
/// side so the peer sees the EOF too. `io::copy` alone would leave the other
/// direction waiting forever on a connection the client has finished writing
/// to (and, absent the idle read/write timeouts set on both sockets in
/// `relay_connection`, on a connection that just stopped producing bytes
/// without closing).
fn pump(mut from: impl Read, mut to: TcpStream) -> std::io::Result<()> {
    let result = std::io::copy(&mut from, &mut to).map(|_| ());
    let _ = to.shutdown(Shutdown::Write);
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, Write};

    #[test]
    fn parses_the_gateway_docker_actually_prints() {
        // `{{range .IPAM.Config}}{{.Gateway}} {{end}}` over the default bridge.
        assert_eq!(parse_gateway("172.17.0.1 "), Some(Ipv4Addr::new(172, 17, 0, 1)));
        assert_eq!(parse_gateway("172.17.0.1\n"), Some(Ipv4Addr::new(172, 17, 0, 1)));
    }

    #[test]
    fn skips_an_ipv6_entry_to_find_the_ipv4_one() {
        // A daemon with `--ipv6` reports both; `host-gateway` is the v4 one.
        assert_eq!(parse_gateway("fe80::1 172.17.0.1 "), Some(Ipv4Addr::new(172, 17, 0, 1)));
    }

    /// The rootless case the module doc describes: no gateway printed at all.
    /// Must be None so the caller takes the loud loopback-only path rather than
    /// binding something wrong.
    #[test]
    fn reports_nothing_when_there_is_no_gateway() {
        assert_eq!(parse_gateway(""), None);
        assert_eq!(parse_gateway(" \n"), None);
        assert_eq!(parse_gateway("<no value> "), None);
    }

    /// Stands in for the sidecar: echoes one line back, uppercased, so the test
    /// proves bytes crossed in BOTH directions rather than just connecting.
    fn spawn_echo_server() -> (u16, JoinHandle<()>) {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("bind echo server");
        let port = listener.local_addr().expect("echo addr").port();
        let handle = std::thread::spawn(move || {
            for stream in listener.incoming().take(1).flatten() {
                let mut reader = std::io::BufReader::new(stream.try_clone().expect("clone"));
                let mut line = String::new();
                if reader.read_line(&mut line).is_ok() {
                    let mut stream = stream;
                    let _ = stream.write_all(line.to_uppercase().as_bytes());
                    let _ = stream.flush();
                    let _ = stream.shutdown(Shutdown::Write);
                }
            }
        });
        (port, handle)
    }

    /// End-to-end through the real relay. Binds the relay on loopback (standing
    /// in for the bridge gateway, which no CI runner has) on a free port, and
    /// points it at the echo server on another.
    ///
    /// Note this needs the relay to target an arbitrary port rather than
    /// `spawn`'s same-port-both-sides, so it exercises `relay_connection`
    /// directly — the part that moves bytes — while `spawn` only adds the
    /// listen/accept loop around it.
    #[test]
    fn relays_bytes_in_both_directions() {
        let (echo_port, echo_thread) = spawn_echo_server();

        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("bind relay");
        let relay_port = listener.local_addr().expect("relay addr").port();
        let relay_thread = std::thread::spawn(move || {
            let (inbound, _) = listener.accept().expect("accept");
            relay_connection(inbound, echo_port).expect("relay");
        });

        let mut client =
            TcpStream::connect((Ipv4Addr::LOCALHOST, relay_port)).expect("connect through relay");
        client.write_all(b"hello sidecar\n").expect("write");
        client.flush().expect("flush");
        client.shutdown(Shutdown::Write).expect("half-close");

        let mut response = String::new();
        client.read_to_string(&mut response).expect("read back");

        assert_eq!(response, "HELLO SIDECAR\n");

        relay_thread.join().expect("relay thread");
        echo_thread.join().expect("echo thread");
    }

    /// `spawn` must refuse rather than silently serve nothing when the address
    /// is unusable — an unbindable gateway address is exactly the rootless case
    /// the caller needs to hear about.
    #[test]
    fn spawn_fails_on_an_address_this_host_does_not_have() {
        // TEST-NET-1 (RFC 5737): guaranteed not assigned to a local interface.
        let err = spawn(Ipv4Addr::new(192, 0, 2, 1), 11434).expect_err("must not bind");
        assert!(err.contains("could not listen on"), "unexpected error: {err}");
    }

    /// Shutdown must return — the self-connect that unblocks `accept()` is the
    /// whole reason `RelayHandle` holds `bind_addr`. A regression here hangs app
    /// quit rather than failing visibly.
    #[test]
    fn shutdown_stops_the_accept_loop() {
        let handle = spawn(Ipv4Addr::LOCALHOST, 0).expect("bind on an ephemeral port");
        let bound = handle.bind_addr;
        assert_ne!(bound.port(), 0, "an ephemeral bind must report its real port");

        handle.shutdown();

        // The listener is closed, so the port is free to take again.
        TcpListener::bind(bound).expect("port released after shutdown");
    }

    /// The exact scenario `shutdown`'s own doc comment describes: the wake-up
    /// connect fails (the bridge interface was torn down / the address never
    /// answers), and shutdown must return anyway rather than block on a join
    /// that can never happen. Proven by handing it an accept thread that
    /// would hang forever if joined — if shutdown ever reached the join in
    /// this scenario, this test would hang instead of finishing quickly.
    #[test]
    fn shutdown_does_not_hang_when_the_wake_up_connect_fails() {
        let (never_sent, park) = std::sync::mpsc::channel::<()>();
        let hang_until_dropped = std::thread::spawn(move || {
            // Blocks until `never_sent` is dropped (below), standing in for
            // an accept thread that never observes the shutdown flag because
            // the wake-up connection never reached it.
            let _ = park.recv();
        });

        let handle = RelayHandle {
            // TEST-NET-1 (RFC 5737): guaranteed unconnectable, same address
            // `spawn_fails_on_an_address_this_host_does_not_have` uses.
            bind_addr: SocketAddr::new(IpAddr::V4(Ipv4Addr::new(192, 0, 2, 1)), 11434),
            shutdown: Arc::new(AtomicBool::new(false)),
            accept_thread: Some(hang_until_dropped),
        };

        let started = std::time::Instant::now();
        handle.shutdown();
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "shutdown() blocked instead of returning once the wake-up connect failed"
        );

        // Let the stand-in thread finish so it doesn't outlive the test process.
        drop(never_sent);
    }
}
