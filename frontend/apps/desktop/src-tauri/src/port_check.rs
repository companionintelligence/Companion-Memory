//! Single fixed-port (8642, CI-Server's gateway) preflight check. Unlike a
//! Docker orchestrator managing many dynamic ports, this app only ever needs
//! to reason about the one port `gateway` publishes to the host — see
//! stack_manager::GATEWAY_PORT.

pub fn is_port_available(port: u16) -> bool {
    std::net::TcpListener::bind(("127.0.0.1", port)).is_ok()
}

/// Asks the OS for an ephemeral port by binding to port 0, then releases it —
/// used by local_model::apple_bridge to pick a port for its local HTTP shim.
/// The tiny TOCTOU window between this returning and the real bind is
/// acceptable for a single-user local desktop app with no other process
/// racing for ports on 127.0.0.1.
pub fn find_free_port() -> Option<u16> {
    std::net::TcpListener::bind(("127.0.0.1", 0))
        .ok()
        .and_then(|listener| listener.local_addr().ok())
        .map(|addr| addr.port())
}

pub fn preflight_port(port: u16) -> Result<(), String> {
    if is_port_available(port) {
        return Ok(());
    }
    Err(format!(
        "Port {port} is already in use by another application. Free it and try again, \
         or check whether CI-Server is already running."
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_an_occupied_port() {
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();

        assert!(!is_port_available(port));
        assert!(preflight_port(port).is_err());

        drop(listener);
        assert!(is_port_available(port));
        assert!(preflight_port(port).is_ok());
    }
}
