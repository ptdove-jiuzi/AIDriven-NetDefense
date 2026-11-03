// AIDriven NetDefense — release identity constants (author PT-dove).
//
// Two numbers that must never be confused:
//
//   PRODUCT_VERSION  the repository version. It stays `0.0.0` until the full
//                    release gate passes; this package does not change it.
//   RELEASE_LABEL    the *packaging label* used in the artifact file name only
//                    (`AIDriven-NetDefense-<label>-win-x64-portable.zip`).
//
// The label is a pre-release marker. It says "this is the rc.1 archive of an
// unfrozen tree", not "version 0.0.1 has been released". Nothing in this package
// may be read as a version freeze: see README-快速开始.txt §6.

export const PRODUCT_VERSION = '0.0.0';
export const RELEASE_LABEL = '0.0.1-rc.1';
export const PACKAGE_KIND = 'portable-preview';
export const VERSION_FROZEN = false;
export const AUTHOR = 'PT-dove';
