import com.sun.management.HotSpotDiagnosticMXBean;

import java.lang.management.ManagementFactory;
import java.lang.ref.PhantomReference;
import java.lang.ref.ReferenceQueue;
import java.lang.ref.SoftReference;
import java.lang.ref.WeakReference;

/**
 * Produces a HotSpot HPROF with payloads reachable only through weak, soft,
 * and phantom Reference.referent fields plus one ordinary strong control.
 *
 * <p>The dump is deliberately non-live so the JVM does not clear the special
 * references before serializing them. A strong-reachability analysis must not
 * count the three special referents, while it must retain the control.</p>
 */
public final class ReferenceStrengthCounterexample {
    private static volatile WeakReference<Payload> weakOnly;
    private static volatile SoftReference<Payload> softOnly;
    private static volatile PhantomReference<Payload> phantomOnly;
    private static volatile ReferenceQueue<Payload> phantomQueue;
    private static volatile Payload strongControl;

    private static final class Payload {
        final byte[] bytes;

        Payload(int mebibytes) {
            bytes = new byte[mebibytes * 1024 * 1024];
        }
    }

    private ReferenceStrengthCounterexample() {}

    private static void buildGraph() {
        weakOnly = new WeakReference<>(new Payload(2));
        softOnly = new SoftReference<>(new Payload(3));
        phantomQueue = new ReferenceQueue<>();
        phantomOnly = new PhantomReference<>(new Payload(4), phantomQueue);
        strongControl = new Payload(1);
    }

    public static void main(String[] args) throws Exception {
        if (args.length != 1) {
            throw new IllegalArgumentException("expected output HPROF path");
        }

        buildGraph();

        HotSpotDiagnosticMXBean bean = ManagementFactory.newPlatformMXBeanProxy(
            ManagementFactory.getPlatformMBeanServer(),
            "com.sun.management:type=HotSpotDiagnostic",
            HotSpotDiagnosticMXBean.class
        );
        bean.dumpHeap(args[0], false);

        if (weakOnly == null || softOnly == null || phantomOnly == null
            || phantomQueue == null || strongControl.bytes.length == 0) {
            throw new AssertionError("reference-strength regression graph was not preserved");
        }
    }
}
