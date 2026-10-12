---
sidebar_position: 10
title: Monitor
---

Monitor connects to the **separate HeapLens JVM metrics agent**, then polls metrics/histograms. Opening an HPROF file does not install an agent or grant JVM attachment permissions.

## Security first

The current sidecar's metrics server uses a TCP listener without a built-in authentication/TLS layer and can bind beyond loopback. **Do not expose it or an unsecured JMX port to an untrusted network.** Restrict interfaces with host firewall/network isolation; use only an authorized trusted local test environment. The browser host's loopback policy does not secure this separate agent.

The current remote collector does not supply a general authenticated-JMX setup workflow. Do not turn production JMX authentication off to make a demo work. Production network hardening is a separate product requirement.

## Local sidecar setup

A compatible JVM/JDK and an explicitly configured target JMX connection are required. Build/provide the separate sidecar JAR, then, only in an authorized isolated test environment with a compatible already-configured JMX endpoint, run:

```bash
java -jar /absolute/path/heaplens-agent.jar \
  --jmx-host localhost --jmx-port 9010 --listen-port 9095 --idle-timeout 60
```

Replace the JAR path and port. Verify that the metrics belong to the intended target. This is a sidecar JAR command, not `-javaagent` instrumentation or automatic PID attachment.

**Known target-selection limitation:** although `--pid` is parsed, the current collector does not implement Attach API lookup for that PID. Without a supplied JMX port it falls back to the sidecar's own platform MBean server. Do not present `--pid` alone as successful target monitoring. This requires a product fix and a target-identity test.

For an already configured permitted JMX endpoint, agent arguments include `--jmx-host` and `--jmx-port`; this does not itself secure that endpoint.

## In the view

Connect to the agent address/port using Monitor controls. Check connection status and poll interval; review JVM memory/GC/thread/class metrics and on-demand histograms. Metrics are samples, not a replacement for heap ownership analysis.

Where capture is offered, the output path belongs to the target/agent machine. Capture may pause the JVM, require disk space and permissions, and contain secrets. Confirm path ownership before opening the resulting dump.

Disconnect when done and stop the sidecar. Idle timeout is not an access-control mechanism. Monitor controls differ by host; use the connection and capture actions available in your installation. See [safe capture](../getting-started/generating-heap-dumps.md).
