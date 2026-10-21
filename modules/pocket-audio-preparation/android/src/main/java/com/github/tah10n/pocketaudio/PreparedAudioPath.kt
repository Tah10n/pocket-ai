package com.github.tah10n.pocketaudio

import java.io.File

/** Preserve Expo's cache spelling while proving that it identifies our canonical output. */
internal object PreparedAudioPath {
  fun emittedFile(cacheDirectory: File, ownedRoot: File, ownedFile: File): File {
    val emittedRoot = File(cacheDirectory, "audio-preparation")
    val canonicalRoot = ownedRoot.canonicalFile
    require(emittedRoot.canonicalFile == canonicalRoot) { "invalid_audio" }
    require(ownedFile.parentFile == canonicalRoot && ownedFile.name.matches(Regex("[a-f0-9-]+\\.wav"))) { "invalid_audio" }
    val canonicalFile = ownedFile.canonicalFile
    require(canonicalFile.parentFile == canonicalRoot && canonicalFile.name == ownedFile.name) { "invalid_audio" }
    val emitted = File(emittedRoot, ownedFile.name)
    require(emitted.canonicalFile == canonicalFile) { "invalid_audio" }
    return emitted
  }
}
