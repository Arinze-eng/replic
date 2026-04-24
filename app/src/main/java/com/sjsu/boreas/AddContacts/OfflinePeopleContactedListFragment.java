package com.sjsu.boreas.AddContacts;

import android.content.Context;
import android.os.AsyncTask;
import android.os.Bundle;
import android.util.Log;
import android.view.LayoutInflater;
import android.view.View;
import android.view.ViewGroup;
import android.widget.SearchView;

import androidx.annotation.Nullable;
import androidx.fragment.app.Fragment;
import androidx.recyclerview.widget.LinearLayoutManager;
import androidx.recyclerview.widget.RecyclerView;

import com.sjsu.boreas.Database.LocalDatabaseReference;
import com.sjsu.boreas.OnlineConnectionHandlers.FirebaseController;
import com.sjsu.boreas.ContactRecyclerItems.UserListAdapter;
import com.sjsu.boreas.R;
import com.sjsu.boreas.Database.Contacts.User;
import com.sjsu.boreas.ContactRecyclerItems.UserListItemClickAction;

import java.util.ArrayList;

public class OfflinePeopleContactedListFragment extends Fragment implements UserListItemClickAction {

    private static final String EXTRA_TAB_NAME = "tab_name";
    private String mTabName;
    private static String TAG = "BOREAS";
    private static String SUB_TAG = "---Offline people who were contacted";

    private View rootView;
    private RecyclerView recyclerView;
    private LinearLayoutManager layoutManager;
    private AddContactActivity mParent;
    private SearchView searchBar;
    private ArrayList<User> userArrayList;
    private UserListAdapter mAdapter;
    private Context mContext;
    private UserListItemClickAction userListItemClickAction;

    @Override
    public void onCreate(Bundle savedInstanceState){
        Log.e(TAG, SUB_TAG+"    on create");
        super.onCreate(savedInstanceState);
        mParent = (AddContactActivity) getActivity();

    }

    @Override
    public void onAttach(Context context) {
        Log.e(TAG, SUB_TAG+"onAttach");
        super.onAttach(context);
    }

    @Override
    public View onCreateView(LayoutInflater inflater, ViewGroup container,
                             Bundle savedInstanceState){
        Log.e(TAG, SUB_TAG+"    on Create view");
        // Inflate the layout for this fragment
        rootView = inflater.inflate(R.layout.fragment_offline_people_contacted, container, false);
        mTabName = getArguments().getString(EXTRA_TAB_NAME);
        mContext = container.getContext();
        return rootView;
    }

    @Override
    public void onViewCreated(View view, @Nullable Bundle savedInstanceState) {
        super.onViewCreated(view, savedInstanceState);
        initUI();
    }

    public static OfflinePeopleContactedListFragment newInstance(String tabName) {
        Log.e(TAG, SUB_TAG+"OneOnOneFragment");
        Bundle args = new Bundle();
        args.putString(EXTRA_TAB_NAME, tabName);
        OfflinePeopleContactedListFragment fragment = new OfflinePeopleContactedListFragment();
        fragment.setArguments(args);
        return fragment;
    }

    private void initUI() {
        Log.e(TAG, SUB_TAG+"initUI");
        recyclerView = rootView.findViewById(R.id.offline_ppl_list);
        recyclerView.setHasFixedSize(true);
        layoutManager = new LinearLayoutManager(mParent);
        recyclerView.setLayoutManager(layoutManager);
        searchBar = rootView.findViewById(R.id.search_bar_offline);

        initializeAdapter();

        manageMessageFromWorkerThread();
//        firebaseContactsAdapter();
    }


    private void searchOfflinePeopleList(String searchedName){
        Log.e(TAG, SUB_TAG+"    Search Firebase contacts");
        ArrayList<User> filteredContacts = new ArrayList<User>();

        for(User u : userArrayList){
            if(u.name.toLowerCase().contains(searchedName.toLowerCase())){
                filteredContacts.add(u);
            }
        }

        UserListAdapter newAdapter = new UserListAdapter(filteredContacts, mContext, userListItemClickAction);
        recyclerView.setAdapter(newAdapter);
    }

    public void initializeAdapter() {
        super.onStart();
//        mAdapter2.startListening();
        Log.e(TAG, SUB_TAG+"----intialize custom firebase");

        final LocalDatabaseReference localDatabaseReference = LocalDatabaseReference.get();
        AsyncTask.execute(new Runnable() {
            @Override
            public void run() {
                userArrayList = new ArrayList<User>(localDatabaseReference.getContacts());
                mAdapter=new UserListAdapter(userArrayList, mContext, userListItemClickAction);
                recyclerView.setAdapter(mAdapter);
            }
        });

        if(searchBar != null){
            searchBar.setOnQueryTextListener(new SearchView.OnQueryTextListener() {
                @Override
                public boolean onQueryTextSubmit(String query) {
                    return false;
                }

                @Override
                public boolean onQueryTextChange(String newText) {
                    Log.e(TAG, SUB_TAG+"    searching firebase contact");
                    searchOfflinePeopleList(newText);
                    return true;
                }
            });
        }
    }

    @Override
    public void onStop() {
        super.onStop();
//        mAdapter2.stopListening();
    }

    private void manageMessageFromWorkerThread(){
        Log.e(TAG, SUB_TAG+"***********************Manage messg from worker thread");

    }

    @Override
    public void onItemClicked(User model, int position) {
        Log.e(TAG, SUB_TAG+"on item clicked");
        FirebaseController.addContact(model);
        LocalDatabaseReference localDatabaseReference = LocalDatabaseReference.get();
        localDatabaseReference.addContact(model);
    }
}
