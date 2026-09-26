import com.sun.management.HotSpotDiagnosticMXBean;
import java.lang.instrument.Instrumentation;
import java.lang.management.ManagementFactory;
import java.lang.reflect.Array;
import java.util.ArrayList;
import java.util.List;

/** Independent shallow-size oracle. Build as a javaagent and run with -javaagent.
 * Each Sample records Instrumentation.getObjectSize(value) inside the HPROF.
 * No HeapLens or MAT formula is used to produce expected bytes.
 */
public final class ShallowSizeCounterexample {
    private static Instrumentation instrumentation;
    private static final List<Sample> samples = new ArrayList<>();
    public static void premain(String args, Instrumentation inst) { instrumentation = inst; }

    static final class Empty {}
    static class OneReference { Object a; }
    static final class TwoReferences extends OneReference { Object b; }
    static class PrimitiveParent { long wide; int integer; }
    static final class PrimitiveChild extends PrimitiveParent { byte small; Object ref; }
    static final class Mixed { long wide; double number; int integer; short small; byte tiny; Object ref; }
    static final class Sample {
        final Object value;
        final long expectedSize;
        Sample(Object value) {
            this.value = value;
            this.expectedSize = instrumentation.getObjectSize(value);
        }
    }
    private static void add(Object value) { samples.add(new Sample(value)); }

    public static void main(String[] args) throws Exception {
        if (args.length != 1 || instrumentation == null)
            throw new IllegalArgumentException("Use -javaagent:oracle.jar ShallowSizeCounterexample output.hprof");
        add(new Empty());
        add(new OneReference());
        add(new TwoReferences());
        add(new PrimitiveParent());
        add(new PrimitiveChild());
        add(new Mixed());
        Class<?>[] types = {Object.class, boolean.class, byte.class, char.class, short.class,
                           int.class, float.class, long.class, double.class};
        for (Class<?> type : types)
            for (int length : new int[]{0, 1, 2, 3, 7, 8, 9, 257})
                add(Array.newInstance(type, length));
        // Adjacent arrays provide evidence for compressed-reference inference.
        for (int i = 0; i < 128; i++) add(new Object[33]);
        HotSpotDiagnosticMXBean bean = ManagementFactory.getPlatformMXBean(HotSpotDiagnosticMXBean.class);
        for (String option : new String[]{"UseCompressedOops", "UseCompressedClassPointers", "ObjectAlignmentInBytes"})
            System.out.println(option + "=" + bean.getVMOption(option).getValue());
        bean.dumpHeap(args[0], true);
        System.out.println("Oracle samples=" + samples.size());
    }
}
