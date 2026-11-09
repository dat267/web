// Termux/Android shim for playwright-core.
// playwright-core's serverRegistry throws "Unsupported platform: android" when it
// computes its cache directory, even when --executable-path points at a system
// browser. Report "linux" so those code paths take the Linux branch.
Object.defineProperty(process, "platform", { value: "linux", configurable: true });
