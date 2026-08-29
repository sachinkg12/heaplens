import com.sun.management.HotSpotDiagnosticMXBean;

import java.lang.management.ManagementFactory;

/**
 * Produces a real HotSpot HPROF containing the cyclic cross-edge graph used by
 * the indexed dominator regression test.
 *
 * <p>The marker object X is reachable through both Holder -> A -> X and
 * Holder -> C -> X, so its immediate dominator must be Holder. The longer
 * Holder -> A -> B -> C -> X path exercises path compression.</p>
 */
public final class DominatorCounterexample {
    private static volatile Holder keepAlive;

    private static final class Holder {
        A a;
        C c;
    }

    private static final class A {
        X x;
        B b;
    }

    private static final class B {
        C c;
    }

    private static final class C {
        X x;
    }

    private static final class X {
        final byte[] marker = new byte[257];
    }

    private DominatorCounterexample() {}

    private static Holder buildGraph() {
        Holder holder = new Holder();
        holder.a = new A();
        holder.a.b = new B();
        holder.c = new C();
        holder.a.b.c = holder.c;
        holder.a.x = new X();
        holder.c.x = holder.a.x;
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

        // Keep the graph observably live until dumpHeap returns.
        if (keepAlive.a.x != keepAlive.c.x) {
            throw new AssertionError("counterexample graph was not preserved");
        }
    }
}
