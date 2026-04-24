package com.sjsu.boreas.ContactRecyclerItems;

import android.content.Context;
import android.util.Log;
import android.view.LayoutInflater;
import android.view.View;
import android.view.ViewGroup;

import androidx.annotation.NonNull;
import androidx.recyclerview.widget.RecyclerView;

import com.sjsu.boreas.Database.PotentialContacts.PotentialContacts;
import com.sjsu.boreas.MainActivity;
import com.sjsu.boreas.R;
import com.sjsu.boreas.Database.Contacts.User;

import java.util.ArrayList;
import java.util.List;

public class UserListAdapter extends RecyclerView.Adapter<UserViewHolder>{

    private static String TAG = "BOREAS";
    private static String SUB_TAG = "------AdapterForFirebase-----";
    private List<User>userList;
    private Context context;
    private UserListItemClickAction userListItemClickAction;

    public static final int CONTACT = 0;
    public static final int POTENTIAL_CONTACT = 0;

    public UserListAdapter(ArrayList<User> ul, Context context, UserListItemClickAction userListItemClickAction){
        this.userList = ul;
        this.context = context;
        this.userListItemClickAction = userListItemClickAction;
    }

    @NonNull
    @Override
    public UserViewHolder onCreateViewHolder(@NonNull ViewGroup parent, int viewType) {
        Log.e(TAG, SUB_TAG+"onCreateViewHolder");
        View view = LayoutInflater.from(parent.getContext())
                .inflate(R.layout.item_chat, parent, false);

        return new UserViewHolder(view);
    }

    @Override
    public void onBindViewHolder(@NonNull UserViewHolder holder, final int position) {
        Log.e(TAG, SUB_TAG+"onBindViewHolder");
        final User model = userList.get(position);
        holder.bindToListItemView(model);

        if(model.getUid().equals(MainActivity.currentUser.getUid())) {
            Log.e(TAG, SUB_TAG+"Hiding item for user: " + MainActivity.currentUser.getName());
            holder.hideThisView();
        }

        holder.itemView.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                // Launch PostDetailActivity
                Log.e(TAG, SUB_TAG+"999999999999999999999999 this is the selected user: " + model.getUid());
                userListItemClickAction.onItemClicked(model, position);
            }
        });

    }

    @Override
    public int getItemCount() {
        return userList.size();
    }

}
