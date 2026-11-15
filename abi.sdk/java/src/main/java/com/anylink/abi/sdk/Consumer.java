package com.anylink.abi.sdk;

import java.io.Closeable;
import java.util.Map;

public interface Consumer extends Closeable {
    void add(Map<String, Object> eventRecord) throws Exception;

    void flush() throws Exception;

    @Override
    void close();
}
