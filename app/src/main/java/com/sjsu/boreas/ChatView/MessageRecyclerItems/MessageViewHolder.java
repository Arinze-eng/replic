package com.sjsu.boreas.ChatView.MessageRecyclerItems;

import android.graphics.Bitmap;
import android.net.Uri;
import android.util.Log;
import android.view.View;
import android.widget.ImageView;
import android.widget.TextView;


import androidx.recyclerview.widget.RecyclerView;

import com.sjsu.boreas.ChatView.MediaFilesRecyclerItems.FileItem;
import com.sjsu.boreas.Database.Messages.ChatMessage;
import com.sjsu.boreas.R;

public class MessageViewHolder extends RecyclerView.ViewHolder {

    private static String TAG = "BOREAS";
    private static String SUB_TAG = "------MesssageViewHolder-- ";

    public TextView msg_txt;
    public View rootView;
    public ImageView imageView;

    public MessageViewHolder(View v) {
        super(v);
        Log.e(TAG, SUB_TAG+"Inside message view holder");
        this.rootView = v;
        this.msg_txt = (TextView) v.findViewById(R.id.txt_msg);
        this.imageView = (ImageView) v.findViewById(R.id.mssg_thumbNail);
    }

    public void bindToListItemView(ChatMessage mssg){

        String tmp = mssg.mssgText;
        if(tmp != null && !(tmp.isEmpty())) {
            this.msg_txt.setText(tmp);
        }

        if(mssg.imgUri != null && !(mssg.imgUri.isEmpty())) {
            imageView.setImageURI(Uri.parse(mssg.imgUri));
        }
        else
            imageView.setVisibility(View.GONE);
    }
}
