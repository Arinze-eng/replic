package com.sjsu.boreas.Events;

import java.util.HashMap;

public interface EventListener {
    public void eventTriggered(HashMap<String, Object> packet, String type);
}
