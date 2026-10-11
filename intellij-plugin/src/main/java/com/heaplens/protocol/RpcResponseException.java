package com.heaplens.protocol;

/** Server diagnostic for local UI only. Never log or include it automatically in AI prompts. */
public final class RpcResponseException extends RuntimeException {
    public RpcResponseException(String message) { super(message); }
    public static String display(Throwable error, String fallback) {
        while(error!=null) {
            if(error instanceof RpcResponseException) return error.getMessage();
            error=error.getCause();
        }
        return fallback;
    }
}
