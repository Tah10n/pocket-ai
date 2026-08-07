cmake_minimum_required(VERSION 3.22.1)
project(pocket_anydoc_jni LANGUAGES CXX)

if(NOT DEFINED POCKET_ANYDOC_JNI_LIBS_DIR)
  message(FATAL_ERROR "POCKET_ANYDOC_JNI_LIBS_DIR is required. Run the deterministic Rust build wrapper first.")
endif()

set(POCKET_ANYDOC_LIBRARY "${POCKET_ANYDOC_JNI_LIBS_DIR}/${ANDROID_ABI}/libpocket_anydoc.so")
if(NOT EXISTS "${POCKET_ANYDOC_LIBRARY}")
  message(FATAL_ERROR "The generated Rust library is missing for ${ANDROID_ABI}. Run anydoc:build:android.")
endif()

add_library(pocket_anydoc SHARED IMPORTED GLOBAL)
set_target_properties(pocket_anydoc PROPERTIES IMPORTED_LOCATION "${POCKET_ANYDOC_LIBRARY}")

add_library(pocket_anydoc_jni SHARED pocket_anydoc_jni.cpp)
target_include_directories(pocket_anydoc_jni PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}/../../../../include")
target_compile_features(pocket_anydoc_jni PRIVATE cxx_std_17)
target_compile_options(
  pocket_anydoc_jni
  PRIVATE
    -Wall
    -Wextra
    -Werror
    -fvisibility=hidden
    -fvisibility-inlines-hidden
    -ffunction-sections
    -fdata-sections
)
target_link_options(
  pocket_anydoc_jni
  PRIVATE
    -Wl,-z,max-page-size=16384
    -Wl,-z,common-page-size=16384
    -Wl,--exclude-libs,ALL
    -Wl,--gc-sections
)
target_link_libraries(pocket_anydoc_jni PRIVATE pocket_anydoc log)
