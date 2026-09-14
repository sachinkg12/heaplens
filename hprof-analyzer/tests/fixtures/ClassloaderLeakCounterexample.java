import com.sun.management.HotSpotDiagnosticMXBean;

import java.lang.management.ManagementFactory;
import java.nio.file.Files;
import java.nio.file.Path;

/**
 * Produces a real HotSpot HPROF containing a significant custom classloader.
 *
 * <p>The 24 MiB baseline keeps the loader's 2 MiB retained subtree between
 * HeapLens's 5% classloader threshold and its 10% generic-object threshold.
 * The indexed backend must therefore use the HPROF classloader IDs rather
 * than discovering this loader accidentally as a generic large object.</p>
 */
public final class ClassloaderLeakCounterexample {
    private static final String PAYLOAD_CLASS = "ClassloaderLeakPayload";

    private static volatile byte[] baseline;
    private static volatile LeakingClassLoader keepAliveLoader;
    private static volatile Class<?> keepAliveClass;

    private static final class LeakingClassLoader extends ClassLoader {
        private final Path payloadClassFile;
        private final byte[] retainedPayload = new byte[2 * 1024 * 1024];

        LeakingClassLoader(Path payloadClassFile) {
            super(ClassloaderLeakCounterexample.class.getClassLoader());
            this.payloadClassFile = payloadClassFile;
        }

        @Override
        protected Class<?> loadClass(String name, boolean resolve) throws ClassNotFoundException {
            synchronized (getClassLoadingLock(name)) {
                Class<?> loaded = findLoadedClass(name);
                if (loaded == null) {
                    loaded = PAYLOAD_CLASS.equals(name)
                        ? findClass(name)
                        : super.loadClass(name, false);
                }
                if (resolve) {
                    resolveClass(loaded);
                }
                return loaded;
            }
        }

        @Override
        protected Class<?> findClass(String name) throws ClassNotFoundException {
            if (!PAYLOAD_CLASS.equals(name)) {
                throw new ClassNotFoundException(name);
            }
            try {
                byte[] bytes = Files.readAllBytes(payloadClassFile);
                return defineClass(name, bytes, 0, bytes.length);
            } catch (Exception error) {
                throw new ClassNotFoundException(name, error);
            }
        }
    }

    private ClassloaderLeakCounterexample() {}

    public static void main(String[] args) throws Exception {
        if (args.length != 2) {
            throw new IllegalArgumentException(
                "expected output HPROF path and ClassloaderLeakPayload.class path"
            );
        }

        baseline = new byte[24 * 1024 * 1024];
        keepAliveLoader = new LeakingClassLoader(Path.of(args[1]));
        keepAliveClass = Class.forName(PAYLOAD_CLASS, true, keepAliveLoader);
        System.gc();

        HotSpotDiagnosticMXBean bean = ManagementFactory.newPlatformMXBeanProxy(
            ManagementFactory.getPlatformMBeanServer(),
            "com.sun.management:type=HotSpotDiagnostic",
            HotSpotDiagnosticMXBean.class
        );
        bean.dumpHeap(args[0], true);

        if (keepAliveClass.getClassLoader() != keepAliveLoader
            || keepAliveLoader.retainedPayload.length == 0
            || baseline.length == 0) {
            throw new AssertionError("classloader regression graph was not preserved");
        }
    }
}
