import UIKit

/// The lock screen a locked app shows: a native view added above Capacitor's web view. The
/// page underneath stays loaded and keeps syncing; the user cannot see or touch it until
/// the OS prompt passes. SECURITY_ARCHITECTURE.md § 4.3's v2 — a view over the web view,
/// not a route the page could be driven past.
///
/// Plain UIKit and no assets, so the plugin needs nothing from the host app.
final class LockOverlayView: UIView {
    private let noteLabel = UILabel()
    private let onUnlock: () -> Void

    init(onUnlock: @escaping () -> Void) {
        self.onUnlock = onUnlock
        super.init(frame: .zero)

        backgroundColor = UIColor(red: 0.043, green: 0.071, blue: 0.125, alpha: 1) // #0B1220
        isUserInteractionEnabled = true
        isAccessibilityElement = false
        accessibilityLabel = "Companion Memory is locked"

        let title = UILabel()
        title.text = "Companion Memory"
        title.textColor = .white
        title.font = .systemFont(ofSize: 22, weight: .bold)
        title.textAlignment = .center

        let subtitle = UILabel()
        subtitle.text = "Locked"
        subtitle.textColor = Self.muted
        subtitle.font = .systemFont(ofSize: 16)
        subtitle.textAlignment = .center

        noteLabel.textColor = Self.muted
        noteLabel.font = .systemFont(ofSize: 14)
        noteLabel.textAlignment = .center
        noteLabel.numberOfLines = 0
        noteLabel.isHidden = true

        let button = UIButton(type: .system)
        button.setTitle("Unlock", for: .normal)
        button.titleLabel?.font = .systemFont(ofSize: 17, weight: .semibold)
        button.setTitleColor(.white, for: .normal)
        button.backgroundColor = UIColor(white: 1, alpha: 0.14)
        button.layer.cornerRadius = 12
        button.contentEdgeInsets = UIEdgeInsets(top: 12, left: 28, bottom: 12, right: 28)
        button.addTarget(self, action: #selector(unlockTapped), for: .touchUpInside)

        let column = UIStackView(arrangedSubviews: [title, subtitle, noteLabel, button])
        column.axis = .vertical
        column.alignment = .center
        column.spacing = 8
        column.setCustomSpacing(28, after: noteLabel)
        column.translatesAutoresizingMaskIntoConstraints = false
        addSubview(column)

        NSLayoutConstraint.activate([
            column.centerXAnchor.constraint(equalTo: centerXAnchor),
            column.centerYAnchor.constraint(equalTo: centerYAnchor),
            column.leadingAnchor.constraint(greaterThanOrEqualTo: safeAreaLayoutGuide.leadingAnchor, constant: 32),
            column.trailingAnchor.constraint(lessThanOrEqualTo: safeAreaLayoutGuide.trailingAnchor, constant: -32),
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    /// The line under "Locked" — a queue depth, never content. Empty hides it.
    func setNote(_ text: String) {
        noteLabel.text = text
        noteLabel.isHidden = text.trimmingCharacters(in: .whitespaces).isEmpty
    }

    @objc private func unlockTapped() {
        onUnlock()
    }

    private static let muted = UIColor(red: 0.714, green: 0.761, blue: 0.820, alpha: 1) // #B6C2D1
}
