// Native N-API addon: NSWindowCollectionBehaviorStationary for overlay windows.
//
// Electron only exposes setHiddenInMissionControl(), which maps to
// NSWindowCollectionBehaviorTransient — and transient windows are REMOVED
// from screen while Mission Control / Exposé is active. Native notch apps
// (HeyClicky's OverlayWindow.swift) instead use .stationary, which keeps the
// window on screen "unaffected by Exposé, like the desktop window": no
// scaling along with the desktop on Mission Control entry, no disappearing
// during three-finger Space swipes, never a selectable Mission Control tile.
//
// Setting the flag once is NOT enough in Electron: its own code rewrites the
// window's collectionBehavior whenever it re-asserts visibility flags
// (setVisibleOnAllWorkspaces, setAlwaysOnTop, fullscreen transitions...),
// which strips stationary until the next JS-side re-assert — exactly the
// window of time in which a Space swipe or Mission Control animation drags
// the notch along. So makeStationary() ENFORCES the flag with a method
// swizzle on setCollectionBehavior:, gated per window by an associated-object
// flag. (NOT an isa-swizzle/dynamic subclass — that fights AppKit's KVO
// machinery on NSWindow and traps at teardown.) Windows without the flag are
// passed through untouched.
//
// Stationary alone turned out NOT to be enough on macOS 26: measured with a
// CGWindowList poller, the window server bounds-animates even a NATIVE panel
// with the full canJoinAllSpaces|stationary flag set during a three-finger
// Space swipe. The apps that truly never blink (boring.notch's SkyLight mode,
// via Lakr233/SkyLightWindow) move the window OUT of the user's spaces
// entirely: SLSSpaceCreate a private window-server space, set its absolute
// level to 400 (NotificationCenterAtScreenLock), SLSShowSpaces it so it is
// always composited, and SLSSpaceAddWindowsAndRemoveFromSpaces the window
// into it. A window in its own always-shown space does not participate in
// space transitions at all. pinToSpace() implements exactly that. Private
// SkyLight API — fine outside the App Store; SkyLight is Apple-signed, so
// dlopen works under hardened runtime without extra entitlements.
//
// Built by scripts/vendor-macwindow.sh into resources/native/ (universal
// arm64 + x86_64); loaded from src/main/native-window-behavior.ts.

#include <dlfcn.h>
#include <node_api.h>
#import <AppKit/AppKit.h>
#import <objc/runtime.h>

static const NSWindowCollectionBehavior kForcedBits =
    NSWindowCollectionBehaviorCanJoinAllSpaces |
    NSWindowCollectionBehaviorStationary |
    NSWindowCollectionBehaviorFullScreenAuxiliary |
    NSWindowCollectionBehaviorIgnoresCycle;

// Flags that conflict with the forced set (transient/managed/stationary are
// one mutually-exclusive group; same for the spaces and cycling groups).
static const NSWindowCollectionBehavior kClearedBits =
    NSWindowCollectionBehaviorTransient | NSWindowCollectionBehaviorManaged |
    NSWindowCollectionBehaviorMoveToActiveSpace |
    NSWindowCollectionBehaviorParticipatesInCycle |
    NSWindowCollectionBehaviorFullScreenPrimary;

// Per-window opt-in marker for the swizzled setter.
static const void* kEnforceKey = &kEnforceKey;

// setCollectionBehavior: can be implemented at different points of the class
// hierarchy (NSWindow, Electron's NSPanel subclass, ...). Track the original
// IMP per swizzled Method so each class we touch keeps its real behavior.
#define MAX_SWIZZLED 8
static struct {
  Method method;
  IMP original;
} gSwizzled[MAX_SWIZZLED];
static int gSwizzledCount = 0;

static IMP OriginalForMethod(Method method) {
  for (int i = 0; i < gSwizzledCount; i++) {
    if (gSwizzled[i].method == method) return gSwizzled[i].original;
  }
  return NULL;
}

static void EnforcingSetCollectionBehavior(id self, SEL cmd,
                                           NSWindowCollectionBehavior behavior) {
  if (objc_getAssociatedObject(self, kEnforceKey)) {
    behavior |= kForcedBits;
    behavior &= ~kClearedBits;
  }
  Method method = class_getInstanceMethod(object_getClass(self), cmd);
  IMP original = OriginalForMethod(method);
  if (original) {
    ((void (*)(id, SEL, NSWindowCollectionBehavior))original)(self, cmd, behavior);
  }
}

static bool EnsureSwizzled(NSWindow* window) {
  SEL sel = @selector(setCollectionBehavior:);
  Method method = class_getInstanceMethod(object_getClass(window), sel);
  if (!method) return false;
  if (OriginalForMethod(method)) return true;  // this class is already done
  if (gSwizzledCount >= MAX_SWIZZLED) return false;
  IMP original = method_getImplementation(method);
  if (original == (IMP)EnforcingSetCollectionBehavior) return true;
  gSwizzled[gSwizzledCount].method = method;
  gSwizzled[gSwizzledCount].original = original;
  gSwizzledCount++;
  method_setImplementation(method, (IMP)EnforcingSetCollectionBehavior);
  return true;
}

static NSWindow* WindowFromHandleArg(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc < 1) {
    return nil;
  }
  // BrowserWindow.getNativeWindowHandle() — a Buffer holding an NSView*.
  void* data = NULL;
  size_t length = 0;
  if (napi_get_buffer_info(env, argv[0], &data, &length) != napi_ok ||
      length < sizeof(void*)) {
    return nil;
  }
  NSView* view = *reinterpret_cast<NSView* const*>(data);
  return view ? view.window : nil;
}

static napi_value MakeStationary(napi_env env, napi_callback_info info) {
  napi_value result;
  napi_get_boolean(env, false, &result);

  NSWindow* window = WindowFromHandleArg(env, info);
  if (!window) return result;
  if (!EnsureSwizzled(window)) return result;

  objc_setAssociatedObject(window, kEnforceKey, @YES,
                           OBJC_ASSOCIATION_RETAIN_NONATOMIC);
  // Route the current value through the enforcing setter.
  [window setCollectionBehavior:window.collectionBehavior];

  napi_get_boolean(env, true, &result);
  return result;
}

// ─── SkyLight always-on space ───

typedef int32_t (*F_SLSMainConnectionID)(void);
typedef int32_t (*F_SLSSpaceCreate)(int32_t, int32_t, int32_t);
typedef int32_t (*F_SLSSpaceSetAbsoluteLevel)(int32_t, int32_t, int32_t);
typedef int32_t (*F_SLSShowSpaces)(int32_t, CFArrayRef);
typedef int32_t (*F_SLSSpaceAddWindowsAndRemoveFromSpaces)(int32_t, int32_t,
                                                           CFArrayRef, int32_t);

// kSLSSpaceAbsoluteLevelNotificationCenterAtScreenLock — what
// SkyLightWindow/boring.notch use for their notch surface.
static const int32_t kSpaceAbsoluteLevel = 400;

static int32_t gConnection = 0;
static int32_t gSpace = 0;
static F_SLSSpaceAddWindowsAndRemoveFromSpaces gAddWindowsToSpace = NULL;

static bool EnsureSkyLightSpace(void) {
  static bool attempted = false;
  if (attempted) return gSpace != 0;
  attempted = true;

  void* handle = dlopen(
      "/System/Library/PrivateFrameworks/SkyLight.framework/Versions/A/SkyLight",
      RTLD_NOW);
  if (!handle) return false;
  F_SLSMainConnectionID mainConnectionID =
      (F_SLSMainConnectionID)dlsym(handle, "SLSMainConnectionID");
  F_SLSSpaceCreate spaceCreate = (F_SLSSpaceCreate)dlsym(handle, "SLSSpaceCreate");
  F_SLSSpaceSetAbsoluteLevel spaceSetAbsoluteLevel =
      (F_SLSSpaceSetAbsoluteLevel)dlsym(handle, "SLSSpaceSetAbsoluteLevel");
  F_SLSShowSpaces showSpaces = (F_SLSShowSpaces)dlsym(handle, "SLSShowSpaces");
  gAddWindowsToSpace = (F_SLSSpaceAddWindowsAndRemoveFromSpaces)dlsym(
      handle, "SLSSpaceAddWindowsAndRemoveFromSpaces");
  if (!mainConnectionID || !spaceCreate || !spaceSetAbsoluteLevel || !showSpaces ||
      !gAddWindowsToSpace) {
    gAddWindowsToSpace = NULL;
    return false;
  }

  gConnection = mainConnectionID();
  gSpace = spaceCreate(gConnection, 1, 0);
  if (gSpace == 0) return false;
  spaceSetAbsoluteLevel(gConnection, gSpace, kSpaceAbsoluteLevel);
  showSpaces(gConnection, (__bridge CFArrayRef) @[ @(gSpace) ]);
  return true;
}

// Move the window into the private always-shown space (and out of every user
// space). Idempotent — re-adding a window already in the space is a no-op on
// the window-server side, so callers can re-pin on every re-assert.
static napi_value PinToSpace(napi_env env, napi_callback_info info) {
  napi_value result;
  napi_get_boolean(env, false, &result);

  NSWindow* window = WindowFromHandleArg(env, info);
  if (!window) return result;
  if (!EnsureSkyLightSpace()) return result;

  NSInteger windowNumber = window.windowNumber;
  if (windowNumber <= 0) return result;  // not yet known to the window server

  // NB: SkyLightWindow / boring.notch ignore the return code (on macOS 26 the
  // call returns a nonzero CGSError yet the window is still moved into the
  // space), so success here means "the window number was valid and we issued
  // the call", not "the window server returned 0".
  gAddWindowsToSpace(gConnection, gSpace,
                     (__bridge CFArrayRef) @[ @(windowNumber) ], 7);

  napi_get_boolean(env, true, &result);
  return result;
}

// Debug/test helper: read back the live collection behavior bits.
static napi_value GetCollectionBehavior(napi_env env, napi_callback_info info) {
  NSWindow* window = WindowFromHandleArg(env, info);
  napi_value result;
  napi_create_double(env, window ? (double)window.collectionBehavior : -1, &result);
  return result;
}

extern "C" __attribute__((visibility("default"))) napi_value
napi_register_module_v1(napi_env env, napi_value exports) {
  napi_value fn;
  if (napi_create_function(env, "makeStationary", NAPI_AUTO_LENGTH, MakeStationary,
                           NULL, &fn) == napi_ok) {
    napi_set_named_property(env, exports, "makeStationary", fn);
  }
  if (napi_create_function(env, "getCollectionBehavior", NAPI_AUTO_LENGTH,
                           GetCollectionBehavior, NULL, &fn) == napi_ok) {
    napi_set_named_property(env, exports, "getCollectionBehavior", fn);
  }
  if (napi_create_function(env, "pinToSpace", NAPI_AUTO_LENGTH, PinToSpace, NULL,
                           &fn) == napi_ok) {
    napi_set_named_property(env, exports, "pinToSpace", fn);
  }
  return exports;
}
