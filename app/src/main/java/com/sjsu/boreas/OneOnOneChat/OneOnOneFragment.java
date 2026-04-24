package com.sjsu.boreas.OneOnOneChat;

import android.content.Context;
import android.content.Intent;
import android.os.AsyncTask;
import android.os.Bundle;
import android.util.Log;
import android.view.LayoutInflater;
import android.view.View;
import android.view.ViewGroup;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.fragment.app.Fragment;
import androidx.recyclerview.widget.LinearLayoutManager;
import androidx.recyclerview.widget.RecyclerView;

import com.google.android.material.floatingactionbutton.FloatingActionButton;
import com.sjsu.boreas.ChatView.ChatActivity;
import com.sjsu.boreas.Database.LocalDatabaseReference;
import com.sjsu.boreas.Database.Messages.ChatMessage;
import com.sjsu.boreas.Database.PotentialContacts.PotentialContacts;
import com.sjsu.boreas.Events.Event;
import com.sjsu.boreas.Events.EventListener;
import com.sjsu.boreas.LandingPage;
import com.sjsu.boreas.Database.Messages.MessageUtility;
import com.sjsu.boreas.R;
import com.sjsu.boreas.ContactRecyclerItems.UserListAdapter;
import com.sjsu.boreas.ContactRecyclerItems.UserListItemClickAction;
import com.sjsu.boreas.Database.AppDatabase;
import com.sjsu.boreas.Database.Contacts.User;
import com.sjsu.boreas.Security.EncryptionController;

import java.util.ArrayList;
import java.util.HashMap;

public class OneOnOneFragment extends Fragment implements EventListener, UserListItemClickAction {
    public static final String EXTRA_TAB_NAME = "tab_name";
    private String mTabName;
    protected RecyclerView recyclerView;
    protected UserListAdapter mAdapter;
    private RecyclerView.LayoutManager layoutManager;
    private LandingPage mParent;
    private View rootView;
    protected Context mContext;
    public static AppDatabase database;
    protected ArrayList<User> adapterContentList;
    protected UserListItemClickAction userListItemClickAction = this;
    private LocalDatabaseReference localDatabaseReference = LocalDatabaseReference.get();

    private static String TAG = "BOREAS";
    private static String SUB_TAG = "---OneOnOne___Frag ";

    public OneOnOneFragment() {
        // Required empty public constructor
    }

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // TODO: this class is inherited by NearbyListFragment.
        //  Following events should be moved to a different subclass
        Event event = Event.get(Event.CHAT_MSSG);
        Event event_users = Event.get(Event.USER_ADDED);
        Event event_user_removed = Event.get(Event.USER_REMOVED);
        event.addListener(this);
        event_users.addListener(this);
        event_user_removed.addListener(this);
        Log.e(TAG, SUB_TAG+"On create");
        mParent = (LandingPage) getActivity();
        super.onCreate(savedInstanceState);
    }

    public static OneOnOneFragment newInstance(String tabName) {
        Log.e(TAG, SUB_TAG+"OneOnOneFragment");
        Bundle args = new Bundle();
        args.putString(EXTRA_TAB_NAME, tabName);
        OneOnOneFragment fragment = new OneOnOneFragment();
        fragment.setArguments(args);
        return fragment;
    }

    @Override
    public void onAttach(Context context) {
        Log.e(TAG, SUB_TAG+"onAttach");
        super.onAttach(context);
        mContext = context;
    }

    @Override
    public View onCreateView(LayoutInflater inflater, ViewGroup container,
                             Bundle savedInstanceState) {
        Log.e(TAG, SUB_TAG+"onCreateView");
        // Inflate the layout for this fragment
        rootView = inflater.inflate(R.layout.fragment_one_on_one, container, false);
        mTabName = getArguments().getString(EXTRA_TAB_NAME);
//        mContext = container.getContext();
//        try {
//            mParent.runOnUiThread(new Runnable() {
//                @Override
//                public void run() {
//                    mAdapter.notifyDataSetChanged();
//                }
//            });
//        }
//        catch (NullPointerException er){
//            Log.e(TAG, SUB_TAG+" Tried to redraw adapter, but adapter is null point.\n"+er);
//        }
        return rootView;
    }

    @Override
    public void onViewCreated(View view, @Nullable Bundle savedInstanceState) {
        super.onViewCreated(view, savedInstanceState);
        initUI();
    }

    protected void initUI() {
        Log.e(TAG, SUB_TAG+"initUI");
        recyclerView = (RecyclerView) rootView.findViewById(R.id.my_recycler_view);
        recyclerView.setHasFixedSize(true);
        layoutManager = new LinearLayoutManager(mParent);
        recyclerView.setLayoutManager(layoutManager);
        final FloatingActionButton fabAdd = (FloatingActionButton) getActivity().findViewById(R.id.fabAdd);
        recyclerView.addOnScrollListener(new RecyclerView.OnScrollListener() {
            @Override
            public void onScrolled(@NonNull RecyclerView recyclerView, int dx, int dy) {
                super.onScrolled(recyclerView, dx, dy);
                if (dy > 0)
                    fabAdd.hide();
                else if (dy < 0)
                    fabAdd.show();
            }
        });

        initializeAdapter();

        recyclerView.setAdapter(mAdapter);
    }

    protected void initializeAdapter() {
        super.onStart();
        Log.e(TAG, SUB_TAG+"---- custom local list adapter");

        final LocalDatabaseReference localDatabaseReference = LocalDatabaseReference.get();
        AsyncTask.execute(new Runnable() {
            @Override
            public void run() {
                adapterContentList = new ArrayList<User>(localDatabaseReference.getContacts());
                //Also add any potential contacts chats
                adapterContentList.addAll(localDatabaseReference.getPotentialContacts());
                mAdapter=new UserListAdapter(adapterContentList, mContext, userListItemClickAction);
                mParent.runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        recyclerView.setAdapter(mAdapter);
                    }
                });
            }
        });
    }

    protected void manageMessage(ChatMessage mssg){
        Log.e(TAG, SUB_TAG+"Handling new message event");

        User user = mssg.sender;
        final int i = indexInContact(user);

        //First check if the user is even in our contacts or not?
        if(i>=0){
            adapterContentList.get(i).newMessage = true;
            adapterContentList.get(i).lastMessage = mssg.mssgText;
            localDatabaseReference.updateContactItem(adapterContentList.get(i));
            mParent.runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    mAdapter.notifyItemChanged(i);
                }
            });
        }
        else{
            Log.e(TAG, SUB_TAG+"The sender (" + user.name + ") of the mssg: " + mssg.mssgText + ", is not in the contacts");
            PotentialContacts potentialContact = new PotentialContacts(user.uid, user.name, user.latitude, user.longitude, user.publicKey);
            localDatabaseReference.addPotentialContact(potentialContact);
            adapterContentList.add(potentialContact);
            final int position = adapterContentList.size() - 1;
            adapterContentList.get(position).newMessage = true;
            adapterContentList.get(position).lastMessage = mssg.mssgText;

            mParent.runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    mAdapter.notifyDataSetChanged();
                }
            });
            // add new "potential contact" to list
        }
    }

    protected void removeUserFromList(PotentialContacts potentialContacts){
        Log.e(TAG, SUB_TAG+"remove user from list");

        final int i = indexInContact(potentialContacts);

        if(i < 0){
            Log.e(TAG, SUB_TAG+"Couldn't find the give potential contact in the list");
            return;
        }

        adapterContentList.remove(i);
        mParent.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                mAdapter.notifyItemRemoved(i);
            }
        });
    }

//    mParent.runOnUiThread(new Runnable() {
//        @Override
//        public void run() {
//            mAdapter.notifyDataSetChanged();
//        }
//    });

    // index: of user in Contact list / -1 if user not in Contact
    protected int indexInContact(User user){
        Log.e(TAG, SUB_TAG+"Finding the index of the given user/chat instance");

        for(int i = 0; i < adapterContentList.size(); i++){
            if(adapterContentList.get(i).getUid().equals(user.getUid())){
                Log.e(TAG, SUB_TAG+"The given user is found in the arraylist");
                return i;
            }
        }

        return -1;
    }

    private void newContactAdded(User contact){
        Log.e(TAG, SUB_TAG+"new contact added");
        adapterContentList.add(contact);
        mParent.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                mAdapter.notifyDataSetChanged();
            }
        });
    }

//    public void initializeFirebaseAdapter(){
//        Log.e(TAG, SUB_TAG+"InitializeFirebase adapter");
//
//        Query query = FirebaseDataRefAndInstance.getDatabaseReference().child("contacts").child(MainActivity.currentUser.getUid());
//
//        FirebaseRecyclerOptions<User> options = new FirebaseRecyclerOptions.Builder<User>()
//                .setQuery(query, new SnapshotParser<User>() {
//                    @NonNull
//                    @Override
//                    public User parseSnapshot(@NonNull DataSnapshot snapshot) {
//                        Log.e(TAG, SUB_TAG+"Parse snapshot");
//                        return new User(snapshot.child("uid").getValue().toString(),
//                                snapshot.child("name").getValue().toString(),
//                                Double.parseDouble(snapshot.child("latitude").getValue().toString()),
//                                Double.parseDouble(snapshot.child("longitude").getValue().toString()),
//                                false);
//                    }
//                })
//                .build();
//
//        mAdapter = new FirebaseRecyclerAdapter<User, UsersViewHolder>(options) {
//            @NonNull
//            @Override
//            public UsersViewHolder onCreateViewHolder(@NonNull ViewGroup parent, int viewType) {
//                Log.e(TAG, SUB_TAG+"onCreateViewHolder");
//                View view = LayoutInflater.from(parent.getContext())
//                        .inflate(R.layout.item_chat, parent, false);
//
//                return new UsersViewHolder(view);
//            }
//
//            @Override
//            protected void onBindViewHolder(@NonNull UsersViewHolder holder, int position, @NonNull final User model) {
//                Log.e(TAG, SUB_TAG+"onBindViewHolder");
//                holder.bindToListItemView(model);
//
//                holder.itemView.setOnClickListener(new View.OnClickListener() {
//                    @Override
//                    public void onClick(View v) {
//                        // Launch PostDetailActivity
//                        Intent intent = new Intent(getActivity(), ChatActivity2.class);
//                        //Passing the user object using intent
//                        intent.putExtra("ReceiverObj", model);
//                        startActivity(intent);
//                    }
//                });
//            }
//        };
//    }

//    @Override
//    public void onStart() {
//        super.onStart();
//        mAdapter.startListening();
//    }

    @Override
    public void onStop() {
        super.onStop();
//        mAdapter.stopListening();
    }

    public void eventTriggered(HashMap<String, Object> packet, String type){
        Log.e(TAG, SUB_TAG+"I have received a message, my lord. It goes something like: "+ packet.toString());
        Log.e(TAG, SUB_TAG+"type: " + type);
        // parse chatmessage from packet
        // try catch for parsing user when new user (not in contact list) messages
        if(type.equals(Event.CHAT_MSSG)) {
            Log.e(TAG, SUB_TAG+"this is a chat message event");
            ChatMessage mssg = MessageUtility.convertHashMapToChatMessage(packet);
            ChatMessage temp = mssg.isEncrypted ? EncryptionController.getInstance().getDecryptedMessage(mssg) :
                    mssg;
            manageMessage(temp);
        }else if(type.equals(Event.USER_ADDED)){
            Log.e(TAG, SUB_TAG+"this is a new user event");
            User user = User.convertHashMapToUser(packet);
            newContactAdded(user);
        }else if(type.equals(Event.USER_REMOVED)){
            Log.e(TAG, SUB_TAG+"This is a user removed event");
            PotentialContacts potentialContact = PotentialContacts.convertHashMapToUser(packet);
            removeUserFromList(potentialContact);
        }
    }

    //The UserListItemClick implemented function
    public void onItemClicked(final User model, final int position) {
        Log.e(TAG, SUB_TAG+"on item clicked");
        if(model.newMessage) {
            adapterContentList.get(position).newMessage = false;
            localDatabaseReference.updateContactItem(adapterContentList.get(position));
            mParent.runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    mAdapter.notifyItemChanged(position);
                }
            });
        }

        Intent intent = new Intent(getActivity(), ChatActivity.class);
        //Passing the user object using intent
        intent.putExtra("ReceiverObj", model);
        startActivity(intent);
    }

}
