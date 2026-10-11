package com.heaplens.protocol;

import com.google.gson.*;
import java.io.*;

/** Separate real JVM process, never a mock stream. No filesystem/network access. */
public final class FakeServer {
    public static void main(String[] args) throws Exception {
        BufferedReader input = new BufferedReader(new InputStreamReader(System.in));
        String line;
        while ((line = input.readLine()) != null) {
            JsonObject request = JsonParser.parseString(line).getAsJsonObject();
            switch (request.get("method").getAsString()) {
                case "array" -> {
                    JsonObject reply = new JsonObject(); reply.addProperty("jsonrpc", "2.0");
                    reply.add("id", request.get("id")); reply.add("result", new JsonArray());
                    System.out.println(reply);
                }
                case "malformed" -> System.out.println("not json");
                case "truncated" -> { System.out.print("{broken"); System.out.flush(); return; }
                case "oversized" -> { System.out.print("x".repeat(32 * 1024 * 1024 + 1)); System.out.flush(); }
                case "silent" -> { }
                default -> {
                    JsonObject reply = new JsonObject(); reply.addProperty("jsonrpc", "2.0");
                    reply.add("id", request.get("id")); reply.add("result", request.get("params"));
                    System.out.println(reply);
                }
            }
        }
    }
}
