package com.heaplens.protocol;

import com.google.gson.*;
import java.io.*;
import java.nio.charset.StandardCharsets;

/** Separate real JVM process, never a mock stream. No filesystem/network access. */
public final class FakeServer {
    public static void main(String[] args) throws Exception {
        BufferedReader input = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
        PrintWriter output = new PrintWriter(new OutputStreamWriter(System.out, StandardCharsets.UTF_8), true);
        String line;
        while ((line = input.readLine()) != null) {
            JsonObject request = JsonParser.parseString(line).getAsJsonObject();
            switch (request.get("method").getAsString()) {
                case "array" -> {
                    JsonObject reply = new JsonObject(); reply.addProperty("jsonrpc", "2.0");
                    reply.add("id", request.get("id")); reply.add("result", new JsonArray());
                    output.println(reply);
                }
                case "malformed" -> output.println("not json");
                case "truncated" -> { output.print("{broken"); output.flush(); return; }
                case "oversized" -> { output.print("x".repeat(32 * 1024 * 1024 + 1)); output.flush(); }
                case "silent" -> { }
                default -> {
                    JsonObject reply = new JsonObject(); reply.addProperty("jsonrpc", "2.0");
                    reply.add("id", request.get("id")); reply.add("result", request.get("params"));
                    output.println(reply);
                }
            }
        }
    }
}
