package com.sjsu.boreas.Events;

import com.sjsu.boreas.Database.Messages.ChatMessage;

public interface messageListener {
    public void newMessageReceived(ChatMessage mssg);
    public String getChatPartnerID();
}
