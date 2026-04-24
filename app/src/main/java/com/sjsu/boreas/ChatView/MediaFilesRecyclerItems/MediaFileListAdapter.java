package com.sjsu.boreas.ChatView.MediaFilesRecyclerItems;

import android.util.Log;
import android.view.LayoutInflater;
import android.view.View;
import android.view.ViewGroup;

import androidx.annotation.NonNull;
import androidx.recyclerview.widget.RecyclerView;

import com.sjsu.boreas.Database.Messages.ChatMessage;
import com.sjsu.boreas.MainActivity;
import com.sjsu.boreas.R;

import java.util.List;

public class MediaFileListAdapter extends RecyclerView.Adapter<MediaFileViewHolder>{

    private static String TAG = "BOREAS";
    private static String SUB_TAG = "-------MediaFileListAdapter-- ";

    private List<FileItem> fileItems;
    private ViewGroup parent;
    private FileItemClickedAction fileItemClickedAction;

    private static int NOT_MY_MSSG = 0;
    private static int MY_MSSG = 1;

    public MediaFileListAdapter(List<FileItem> fileItems, FileItemClickedAction fileItemClickedAction) {
        Log.e(TAG, SUB_TAG+"constructor of oneOnOneMessg adapter");
        this.fileItems = fileItems;
        this.fileItemClickedAction = fileItemClickedAction;
    }

    @NonNull
    @Override
    public MediaFileViewHolder onCreateViewHolder(@NonNull ViewGroup parent, int viewType) {
        Log.e(TAG, SUB_TAG+"onCreateViewHolder");
        this.parent = parent;
        View view;

        view = LayoutInflater.from(parent.getContext()).inflate(R.layout.item_image_thumbnail, parent, false);

       return new MediaFileViewHolder(view);
    }


    @Override
    public void onBindViewHolder(@NonNull final MediaFileViewHolder holder, final int position) {
        Log.e(TAG, SUB_TAG+"onBindViewHolder");
        FileItem fileItem= fileItems.get(position);
        holder.bindToListItemView(fileItem);

        holder.itemView.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                // Launch PostDetailActivity
                fileItemClickedAction.onItemClicked(holder.getAdapterPosition());
            }
        });
    }

//    @Override
//    public int getItemViewType(int position) {
//        // return a value between 0 and (getViewTypeCount - 1)
//        Log.e(TAG, SUB_TAG+"Checking if this is my message");
//        if(fileItems.get(position).sender.getUid().equals(MainActivity.currentUser.getUid())){
//            Log.e(TAG, SUB_TAG+"This message is from me");
//            return MY_MSSG;
//        }
//
//        return NOT_MY_MSSG;
//    }

    //@Override
//    public View getView(int position, View convertView, ViewGroup parent) {
//        Log.e(TAG, SUB_TAG+"get view");
//        OneOnOneMessageViewHolder holder;
//        LayoutInflater inflater = (LayoutInflater) activity.getSystemService(Activity.LAYOUT_INFLATER_SERVICE);
//
//        int layoutResource = 0; // determined by view type
//
//    }

    private boolean isTheMssgFromMe(ChatMessage mssg){
        Log.e(TAG, SUB_TAG+"Checking if this is my message");
        if(mssg.sender.getUid().equals(MainActivity.currentUser.getUid())){
            Log.e(TAG, SUB_TAG+"This message is from me");
            return true;
        }

        return false;
    }

    //@Override
    public int getViewTypeCount() {
        // return the total number of view types. this value should never change
        // at runtime. Value 2 is returned because of left and right views.
        return 2;
    }

    //@Override
    public int getCount() {
        return 0;
    }

    //@Override
    public Object getItem(int position) {
        return null;
    }

    @Override
    public long getItemId(int position) {
        return 0;
    }

    @Override
    public int getItemCount() {
        return fileItems.size();
    }
}
