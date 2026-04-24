package com.sjsu.boreas.ContactRecyclerItems;

import android.content.Context;
import android.graphics.Color;
import android.graphics.Typeface;
import android.media.Image;
import android.net.Uri;
import android.util.Log;
import android.view.View;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;

import androidx.annotation.NonNull;
import androidx.recyclerview.widget.RecyclerView;

import com.sjsu.boreas.Database.PotentialContacts.PotentialContacts;
import com.sjsu.boreas.Misc.ContextHelper;
import com.sjsu.boreas.R;
import com.sjsu.boreas.Database.Contacts.User;
import com.squareup.picasso.Picasso;

public class UserViewHolder extends RecyclerView.ViewHolder {

    private static String TAG = "BOREAS";
    private static String SUB_TAG = "------UsersViewHolder--- ";

    public View rootView;
    public TextView name;
    public TextView lastMessage;
    private String uid;
    private View newMessageIndicator;
    private ImageView userAvatar;
    private LinearLayout potential;
    public Context context = ContextHelper.get().getApplicationContext();

    public UserViewHolder(@NonNull View itemView) {
        super(itemView);
        Log.e(TAG, SUB_TAG+"UsersViewHolder");
        this.rootView = itemView;
        this.name = itemView.findViewById(R.id.userName);
        this.newMessageIndicator = itemView.findViewById(R.id.newMessage);
        this.lastMessage = itemView.findViewById(R.id.lastMessage);
        this.userAvatar = itemView.findViewById(R.id.userAvatar);
        this.potential = itemView.findViewById(R.id.isPotential);
    }

    public void bindToListItemView(User user) {
        Log.e(TAG, SUB_TAG+"Bind to Post");
        Log.e(TAG, SUB_TAG+"User passed: "+ user.getUid());
        this.name.setText(user.getName());
        this.uid = user.getUid();

        if(user.lastMessage != null){
            this.lastMessage.setText(user.lastMessage);
            Log.e(TAG, SUB_TAG+"User passed LAST MESSAGE: "+ user.lastMessage);
        }
        else{
            this.lastMessage.setVisibility(View.INVISIBLE);
        }

        if(user.newMessage){
            newMessageIndicator.setVisibility(View.VISIBLE);
            this.lastMessage.setTypeface(this.lastMessage.getTypeface(), Typeface.BOLD);
            this.lastMessage.setTextColor(context.getResources().getColor(R.color.colorText));
        }
        else{
            newMessageIndicator.setVisibility(View.INVISIBLE);
            this.lastMessage.setTypeface(this.lastMessage.getTypeface(), Typeface.NORMAL);
            this.lastMessage.setTextColor(context.getResources().getColor(R.color.colorSubtext));
        }

        if(user instanceof PotentialContacts){
            Log.e(TAG, SUB_TAG+"This is the item for the non contact user, changin color");
            this.potential.setVisibility(View.VISIBLE);
        }
        else{
            this.potential.setVisibility(View.GONE);
        }
    }

    // what is this for?
    public void hideThisView(){
        rootView.setVisibility(View.GONE);
        rootView.setLayoutParams(new RecyclerView.LayoutParams(0, 0));
    }

    public String getUID(){
        return uid;
    }
}
