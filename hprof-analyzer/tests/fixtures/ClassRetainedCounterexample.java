import com.sun.management.HotSpotDiagnosticMXBean;

import java.lang.management.ManagementFactory;

/**
 * Produces a real HotSpot HPROF with nested and sibling instances of the same
 * class. The inner Cache subtree is already included in the outer Cache's
 * retained size, while the sibling Cache subtree is disjoint and must be added.
 */
public final class ClassRetainedCounterexample {
    private static volatile Holder keepAlive;

    private static final class Holder {
        Cache outer;
        Cache sibling;
    }

    private static final class Cache {
        Cache child;
        final byte[] marker;

        Cache(int markerSize) {
            marker = new byte[markerSize];
        }
    }

    private ClassRetainedCounterexample() {}

    private static Holder buildGraph() {
        Holder holder = new Holder();
        holder.outer = new Cache(257);
        holder.outer.child = new Cache(127);
        holder.sibling = new Cache(63);
        return holder;
    }

    public static void main(String[] args) throws Exception {
        if (args.length != 1) {
            throw new IllegalArgumentException("expected output HPROF path");
        }

        keepAlive = buildGraph();
        System.gc();

        HotSpotDiagnosticMXBean bean = ManagementFactory.newPlatformMXBeanProxy(
            ManagementFactory.getPlatformMBeanServer(),
            "com.sun.management:type=HotSpotDiagnostic",
            HotSpotDiagnosticMXBean.class
        );
        bean.dumpHeap(args[0], true);

        if (keepAlive.outer.child == null || keepAlive.sibling == null) {
            throw new AssertionError("counterexample graph was not preserved");
        }
    }
}
