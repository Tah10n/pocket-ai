const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { describe, it, expect } = require('@jest/globals');
const plugin = require('../../plugins/withAndroidHmrCompatibility');

const { createSource, applyRegistration } = plugin._internal;
const application = `package example.app
class MainApplication {
  override fun onCreate() {
    super.onCreate()
    loadReactNative(this)
    ApplicationLifecycleDispatcher.onApplicationCreate(this)
  }
}`;

describe('Android HMR compatibility plugin', () => {
  it('registers only in debug builds after RN initialization and survives prebuild twice', () => {
    const once = applyRegistration(application);
    expect(applyRegistration(once)).toBe(once);
    expect(once.match(/PocketHmrCompatibility.install/g)).toHaveLength(1);
    expect(once).toContain('if (BuildConfig.DEBUG) PocketHmrCompatibility.install(reactHost)');
    expect(once.indexOf('loadReactNative(this)')).toBeLessThan(once.indexOf('PocketHmrCompatibility.install'));
    expect(once.indexOf('PocketHmrCompatibility.install')).toBeLessThan(once.indexOf('ApplicationLifecycleDispatcher'));
  });

  it('fails on an incompatible application template instead of silently missing the fix', () => {
    expect(() => applyRegistration('class MainApplication {}')).toThrow();
  });

  it('generates source for the configured package and is wired into Expo prebuild', () => {
    expect(createSource('example.app.qa')).toMatch(/^package example\.app\.qa;/);
    expect(() => createSource('../outside')).toThrow('valid Android package');
    expect(require('../../app.json').expo.plugins).toContain('./plugins/withAndroidHmrCompatibility');
  });

  it('normalizes real JVM no-argument proxies, preserves parameterized calls/errors and handles context reload', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-hmr-jvm-'));
    const files = {
      'example/app/PocketHmrCompatibility.java': createSource('example.app'),
      'com/facebook/react/devsupport/HMRClient.java': `package com.facebook.react.devsupport;
public interface HMRClient {
  void enable(); void disable(); void registerBundle(String url);
  void setup(String platform, String entry, String host, int port, boolean enabled, String scheme);
}`,
      'com/facebook/react/devsupport/interfaces/DevSupportManager.java': `package com.facebook.react.devsupport.interfaces;
public class DevSupportManager {
  public boolean enabled = true;
  public boolean getDevSupportEnabled() { return enabled; }
}`,
      'com/facebook/react/ReactInstanceEventListener.java': `package com.facebook.react;
public interface ReactInstanceEventListener {
  void onReactContextInitialized(com.facebook.react.bridge.ReactContext context);
}`,
      'com/facebook/react/ReactHost.java': `package com.facebook.react;
import com.facebook.react.bridge.ReactContext;
import com.facebook.react.devsupport.interfaces.DevSupportManager;
public class ReactHost {
  public DevSupportManager manager = new DevSupportManager();
  public ReactContext context;
  public ReactInstanceEventListener listener;
  public DevSupportManager getDevSupportManager() { return manager; }
  public ReactContext getCurrentReactContext() { return context; }
  public void addReactInstanceEventListener(ReactInstanceEventListener next) { listener = next; }
}`,
      'com/facebook/react/bridge/ReactContext.java': `package com.facebook.react.bridge;
public class ReactContext {
  public boolean bridgeless = true;
  public Object module;
  public int registrations;
  public boolean isBridgeless() { return bridgeless; }
  public <T> T getJSModule(Class<T> type) { return type.cast(module); }
  public <T> void internal_registerInteropModule(Class<T> type, Object value) {
    module = value; registrations++;
  }
}`,
      'example/app/HmrRegression.java': `package example.app;
import com.facebook.react.ReactHost;
import com.facebook.react.bridge.ReactContext;
import com.facebook.react.devsupport.HMRClient;
import java.lang.reflect.*;
import java.util.*;

public class HmrRegression {
  static void check(boolean condition) { if (!condition) throw new AssertionError(); }
  static class Recorder implements InvocationHandler {
    final List<String> methods = new ArrayList<>();
    Object[] lastArgs;
    Object lastProxy;
    RuntimeException failure;
    public Object invoke(Object proxy, Method method, Object[] args) {
      if (args == null) throw new NullPointerException("RN 0.83 non-null args");
      if (failure != null) throw failure;
      methods.add(method.getName()); lastArgs = args; lastProxy = proxy; return null;
    }
  }
  static HMRClient original(Recorder recorder) {
    return (HMRClient) Proxy.newProxyInstance(HMRClient.class.getClassLoader(),
      new Class<?>[] {HMRClient.class}, recorder);
  }
  public static void main(String[] ignored) {
    Recorder recorder = new Recorder();
    HMRClient original = original(recorder);
    try { original.enable(); throw new AssertionError("must reproduce upstream failure"); }
    catch (NullPointerException expected) { }
    ReactHost host = new ReactHost();
    host.context = new ReactContext(); host.context.module = original;
    PocketHmrCompatibility.install(host);
    HMRClient client = host.context.getJSModule(HMRClient.class);
    client.enable(); check(recorder.lastArgs.length == 0);
    client.disable(); check(recorder.lastArgs.length == 0);
    client.setup("android", "index", "localhost", 8081, true, null);
    check(Arrays.equals(recorder.lastArgs, new Object[] {"android", "index", "localhost", 8081, true, null}));
    client.registerBundle(null);
    check(recorder.lastArgs.length == 1 && recorder.lastArgs[0] == null);
    check(recorder.lastProxy == original);
    check(recorder.methods.equals(Arrays.asList("enable", "disable", "setup", "registerBundle")));
    recorder.failure = new IllegalStateException("original error");
    try { client.enable(); throw new AssertionError("must propagate delegate error"); }
    catch (IllegalStateException failure) { check(failure == recorder.failure); }
    host.listener.onReactContextInitialized(host.context);
    check(host.context.registrations == 1);

    Recorder freshRecorder = new Recorder();
    ReactContext fresh = new ReactContext(); fresh.module = original(freshRecorder);
    host.listener.onReactContextInitialized(fresh);
    fresh.getJSModule(HMRClient.class).enable();
    check(freshRecorder.methods.equals(Arrays.asList("enable")));
    ReactHost pending = new ReactHost();
    PocketHmrCompatibility.install(pending); check(pending.listener != null);
    ReactHost disabled = new ReactHost(); disabled.manager.enabled = false;
    PocketHmrCompatibility.install(disabled); check(disabled.listener == null);
    disabled.manager = null;
    PocketHmrCompatibility.install(disabled); check(disabled.listener == null);
    ReactContext legacy = new ReactContext(); legacy.bridgeless = false;
    host.listener.onReactContextInitialized(legacy); check(legacy.registrations == 0);
    ReactContext empty = new ReactContext();
    host.listener.onReactContextInitialized(empty); check(empty.registrations == 0);
    System.out.println("HMR JVM regression passed");
  }
}`,
    };
    try {
      const sources = Object.entries(files).map(([relative, content]) => {
        const target = path.join(directory, relative);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, content);
        return target;
      });
      const javaTool = (name) => process.env.JAVA_HOME
        ? path.join(process.env.JAVA_HOME, 'bin', `${name}${process.platform === 'win32' ? '.exe' : ''}`)
        : name;
      const compiled = spawnSync(javaTool('javac'), ['-d', directory, ...sources], { encoding: 'utf8', timeout: 20000 });
      expect({ status: compiled.status, error: compiled.error?.message, stderr: compiled.stderr }).toEqual({ status: 0, error: undefined, stderr: '' });
      const ran = spawnSync(javaTool('java'), ['-cp', directory, 'example.app.HmrRegression'], { encoding: 'utf8', timeout: 10000 });
      expect({ status: ran.status, error: ran.error?.message, stderr: ran.stderr }).toEqual({ status: 0, error: undefined, stderr: '' });
      expect(ran.stdout).toContain('HMR JVM regression passed');
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }, 35000);
});
