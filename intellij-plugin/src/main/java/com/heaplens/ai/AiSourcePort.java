package com.heaplens.ai;

import com.heaplens.source.SourceTarget;
import java.util.function.*;

/** Source handles are opaque, created by the IDE resolver, never by the page. */
public interface AiSourcePort {
    record Source(String name,Object handle) { }
    enum Decision { SEND, REVIEW, CANCEL }
    void select(SourceTarget target,BooleanSupplier active,Consumer<Source> result);
    void confirm(Source source,AiConfiguration.Settings settings,BooleanSupplier active,Consumer<Decision> result);
    String readApproved(Source source);
    void review(Source source);
    void diff(Source source,String original,String proposed,BooleanSupplier active);
}
