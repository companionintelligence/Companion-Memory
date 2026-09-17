package com.companionintelligence.speech

import java.io.File

/**
 * Locates repo-relative files for the tests that assert on contracts spanning the
 * Kotlin/TypeScript boundary — where a compiler on neither side sees both halves.
 *
 * Deliberately does not trust the working directory. Gradle points a `Test` task at the
 * module directory, but that is a default an IDE run configuration or a future AGP can
 * change, and a wrong-CWD failure is indistinguishable from a genuinely missing
 * declaration. So the walk starts from both the working directory and this class's own
 * location on disk, and reports every anchor it tried when neither reaches a repo root.
 */
internal object RepoFiles {

    fun read(repoRelativePath: String): String {
        val file = File(repoRoot(), repoRelativePath)
        check(file.isFile) {
            "Expected $repoRelativePath under the repo root ${repoRoot()}. If it moved, the " +
                "cross-language contract it pins moved with it — update this test."
        }
        return file.readText()
    }

    private fun repoRoot(): File {
        val anchors = listOfNotNull(File("").absoluteFile, codeSourceDir())
        for (anchor in anchors) {
            var dir: File? = anchor
            while (dir != null) {
                if (File(dir, "frontend").isDirectory && File(dir, "backend").isDirectory) {
                    return dir
                }
                dir = dir.parentFile
            }
        }
        error("Could not find the repository root (a directory holding both frontend/ and backend/) above $anchors")
    }

    /** Null under a class loader that reports no code source; the CWD anchor still applies. */
    private fun codeSourceDir(): File? = runCatching {
        val location = RepoFiles::class.java.protectionDomain?.codeSource?.location ?: return null
        File(location.toURI()).absoluteFile
    }.getOrNull()
}
