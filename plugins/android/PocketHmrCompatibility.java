package __PACKAGE__;

import com.facebook.react.ReactHost;
import com.facebook.react.bridge.ReactContext;
import com.facebook.react.devsupport.HMRClient;
import com.facebook.react.devsupport.interfaces.DevSupportManager;
import java.lang.reflect.InvocationHandler;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;

/**
 * Debug-only compatibility for React Native 0.83's no-argument HMR calls.
 * Remove once the supported RN release accepts nullable InvocationHandler arguments.
 * Upstream 0.83.10 still requires a non-null array in BridgelessReactContext.kt.
 */
public final class PocketHmrCompatibility {
  private PocketHmrCompatibility() {}

  public static void install(ReactHost host) {
    DevSupportManager devSupport = host.getDevSupportManager();
    if (devSupport == null || !devSupport.getDevSupportEnabled()) {
      return;
    }
    // ReactHost survives reloads; register a fresh wrapper for every new context.
    host.addReactInstanceEventListener(PocketHmrCompatibility::installForContext);
    ReactContext currentContext = host.getCurrentReactContext();
    if (currentContext != null) {
      installForContext(currentContext);
    }
  }

  @SuppressWarnings("deprecation")
  private static void installForContext(ReactContext context) {
    if (!context.isBridgeless()) {
      return;
    }
    HMRClient original = context.getJSModule(HMRClient.class);
    if (original == null || !Proxy.isProxyClass(original.getClass())) {
      return;
    }
    InvocationHandler delegate = Proxy.getInvocationHandler(original);
    if (delegate instanceof NonNullArgumentsHandler) {
      return;
    }
    HMRClient compatible = (HMRClient) Proxy.newProxyInstance(
        HMRClient.class.getClassLoader(),
        new Class<?>[] {HMRClient.class},
        new NonNullArgumentsHandler(original, delegate));
    // RN's existing interop registry avoids changing the bundled react-android AAR.
    context.internal_registerInteropModule(HMRClient.class, compatible);
  }

  private static final class NonNullArgumentsHandler implements InvocationHandler {
    private final HMRClient original;
    private final InvocationHandler delegate;

    NonNullArgumentsHandler(HMRClient original, InvocationHandler delegate) {
      this.original = original;
      this.delegate = delegate;
    }

    @Override
    public Object invoke(Object proxy, Method method, Object[] args) throws Throwable {
      // Java Proxy supplies null for enable()/disable(), but RN 0.83 requires an array.
      // Keep parameterized calls and thrown errors unchanged; no private reflection.
      return delegate.invoke(original, method, args == null ? new Object[0] : args);
    }
  }
}
