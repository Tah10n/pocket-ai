package com.github.tah10n.pocketaudio

import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.nio.file.Files

class PreparedAudioPathTest {
  private val name = "1234-abcd.wav"
  private fun fixture(action: (File, File, File) -> Unit) {
    val temporary = Files.createTempDirectory("audio-path-").toFile()
    try {
      val cache = File(temporary, "cache").apply { check(mkdir()) }
      val root = File(cache, "audio-preparation").apply { check(mkdir()) }.canonicalFile
      val output = File(root, name).apply { writeBytes(byteArrayOf(1, 2, 3)) }
      action(cache, root, output)
    } finally { assertTrue(temporary.deleteRecursively()); assertFalse(temporary.exists()) }
  }
  private fun rejected(action: () -> Unit) {
    try { action(); fail("unowned output accepted") }
    catch (error: IllegalArgumentException) { assertEquals("invalid_audio", error.message) }
  }

  @Test fun preservesExpoCacheSpellingAndActualOutputBytes() = fixture { cache, root, output ->
    val emitted = PreparedAudioPath.emittedFile(cache, root, output)
    assertEquals(File(File(cache, "audio-preparation"), name), emitted)
    assertEquals(output.canonicalFile, emitted.canonicalFile)
    assertArrayEquals(output.readBytes(), emitted.readBytes())
  }

  @Test fun dotSegmentCacheAliasIsPreservedWithoutChangingCanonicalOwnership() = fixture { cache, root, output ->
    val alias = File(cache.parentFile, "cache/../cache")
    assertNotEquals(alias.path, alias.canonicalPath)
    val emitted = PreparedAudioPath.emittedFile(alias, root, output)
    assertEquals(File(File(alias, "audio-preparation"), name).path, emitted.path)
    assertNotEquals(output.path, emitted.path)
    assertEquals(output.canonicalFile, emitted.canonicalFile)
    assertArrayEquals(output.readBytes(), emitted.readBytes())
  }

  @Test fun rejectsDifferentExpoRootEvenWhenChildNameMatches() = fixture { cache, root, output ->
    val differentCache = File(cache.parentFile, "other-cache").apply { check(mkdir()) }
    rejected { PreparedAudioPath.emittedFile(differentCache, root, output) }
    assertTrue(output.exists())
  }

  @Test fun rejectsOutsideRootOutputEvenWithValidName() = fixture { cache, root, output ->
    val outside = File(cache, name).apply { writeBytes(byteArrayOf(4)) }
    rejected { PreparedAudioPath.emittedFile(cache, root, outside) }
    assertTrue(output.exists()); assertTrue(outside.exists())
  }

  @Test fun rejectsNestedOutputAndTraversedOutsideRoot() = fixture { cache, root, output ->
    val nested = File(root, "nested").apply { check(mkdir()) }
    rejected { PreparedAudioPath.emittedFile(cache, root, File(nested, name)) }
    rejected { PreparedAudioPath.emittedFile(cache, root, File(root, "../$name")) }
    assertTrue(output.exists())
  }

  @Test fun rejectsMismatchedOwnedFilename() = fixture { cache, root, output ->
    for (invalid in listOf("recording.wav", "1234-abcd.mp3", "1234-abcd.wav?query", "1234%2fabcd.wav")) {
      rejected { PreparedAudioPath.emittedFile(cache, root, File(root, invalid)) }
    }
    assertTrue(output.exists())
  }
}
