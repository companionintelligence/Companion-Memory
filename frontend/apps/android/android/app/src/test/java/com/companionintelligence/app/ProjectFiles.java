package com.companionintelligence.app;

import java.io.File;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.net.URISyntaxException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.CodeSource;
import java.util.ArrayList;
import java.util.List;
import java.util.function.Predicate;

/**
 * Locates files on disk for the tests that assert on cross-file contracts
 * (the manifest, the iOS Info.plist, the web bundle, the backend config).
 *
 * <p>Deliberately does NOT trust the current working directory. Gradle sets a
 * {@code Test} task's working directory to the module directory, but that is a
 * default an IDE run configuration or a future AGP release can change, and a
 * wrong-CWD failure looks identical to a genuinely missing declaration. So each
 * lookup walks upwards from every plausible anchor until it finds a directory
 * that structurally matches, and throws with the anchors it tried when nothing
 * does.
 */
final class ProjectFiles {

    private ProjectFiles() {}

    /** The {@code :app} Gradle module directory (the one holding {@code src/main/AndroidManifest.xml}). */
    static File appModuleDir() {
        return findAncestor(
            dir -> new File(dir, "src/main/AndroidManifest.xml").isFile(),
            "the :app module directory (a directory containing src/main/AndroidManifest.xml)"
        );
    }

    /** The CI-Server repository (or worktree) root: the directory holding both {@code frontend/} and {@code backend/}. */
    static File repoRoot() {
        return findAncestor(
            dir -> new File(dir, "frontend").isDirectory() && new File(dir, "backend").isDirectory(),
            "the repository root (a directory containing both frontend/ and backend/)"
        );
    }

    /** A repo-root-relative file, e.g. {@code frontend/packages/common/src/utils/oidcNative.ts}. */
    static File inRepo(String relativePath) {
        File file = new File(repoRoot(), relativePath);
        if (!file.isFile()) {
            throw new IllegalStateException(
                "Expected " + relativePath + " to exist under the repo root " + repoRoot() +
                ". If it moved, the cross-file contract it pins moved with it -- update this test."
            );
        }
        return file;
    }

    static String read(File file) {
        try {
            return new String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8);
        } catch (IOException ex) {
            throw new UncheckedIOException("Could not read " + file, ex);
        }
    }

    private static File findAncestor(Predicate<File> matches, String what) {
        List<File> anchors = anchors();
        for (File anchor : anchors) {
            for (File dir = anchor; dir != null; dir = dir.getParentFile()) {
                if (matches.test(dir)) {
                    return dir;
                }
            }
        }
        throw new IllegalStateException("Could not locate " + what + " by walking up from any of " + anchors);
    }

    private static List<File> anchors() {
        List<File> anchors = new ArrayList<>();
        anchors.add(new File("").getAbsoluteFile());
        File codeSource = codeSourceDir();
        if (codeSource != null) {
            anchors.add(codeSource);
        }
        return anchors;
    }

    /**
     * Where this test class's own .class file lives -- always inside the module's
     * build directory, so walking up from it reaches the module and the repo root
     * even if the working directory is somewhere else entirely. Returns null under
     * a class loader that reports no code source (Robolectric's sandbox loader can).
     */
    private static File codeSourceDir() {
        try {
            CodeSource codeSource = ProjectFiles.class.getProtectionDomain().getCodeSource();
            if (codeSource == null || codeSource.getLocation() == null) {
                return null;
            }
            return new File(codeSource.getLocation().toURI()).getAbsoluteFile();
        } catch (URISyntaxException | IllegalArgumentException | SecurityException ex) {
            return null;
        }
    }
}
