package com.sjsu.boreas.pdel_messaging;

import android.app.Activity;
import android.content.Context;
import android.view.LayoutInflater;
import android.view.View;
import android.view.ViewGroup;
import android.widget.BaseAdapter;
import android.widget.TextView;

import com.sjsu.boreas.R;

import java.util.ArrayList;
import java.util.List;

public class ChatMessageAdapter extends BaseAdapter {

    List<Message> messages = new ArrayList<>();
    private Context context;

    public ChatMessageAdapter(Context context){
        this.context = context;
    }

    public void addMessage(Message message){
        messages.add(message);
        notifyDataSetChanged();
    }

    @Override
    public int getCount() {
        return messages.size();
    }

    @Override
    public Object getItem(int i) {
        return messages.get(i);
    }

    @Override
    public long getItemId(int i) {
        return i;
    }

    @Override
    public View getView(int i, View view, ViewGroup viewGroup) {
        MessageViewHolder holder = new MessageViewHolder();
        LayoutInflater messageInflater = (LayoutInflater) context.getSystemService(Activity.LAYOUT_INFLATER_SERVICE);
        Message message = messages.get(i);

        if(message.getIsSender()){
            view = messageInflater.inflate(R.layout.message_text_sent, null);
            holder.messageBody = (TextView) view.findViewById(R.id.message_body);
            view.setTag(holder);
            holder.messageBody.setText(message.getText());
        }else{
            view = messageInflater.inflate(R.layout.message_text_received, null);
            holder.name = (TextView) view.findViewById(R.id.name);
            holder.messageBody = (TextView) view.findViewById(R.id.message_body);
            view.setTag(holder);

            holder.name.setText(message.getSender());
            holder.messageBody.setText(message.getText());
        }

        return view;
    }

    class MessageViewHolder{
        public TextView name;
        public TextView messageBody;
    }

}

