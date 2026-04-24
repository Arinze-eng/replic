package com.sjsu.boreas.AddContacts;

import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.widget.SearchView;

import androidx.appcompat.app.AppCompatActivity;
import androidx.core.content.ContextCompat;
import androidx.fragment.app.Fragment;
import androidx.fragment.app.FragmentTransaction;
import androidx.recyclerview.widget.RecyclerView;
import androidx.viewpager.widget.ViewPager;

import com.google.android.material.tabs.TabLayout;
import com.sjsu.boreas.Database.LocalDatabaseReference;
import com.sjsu.boreas.LandingPage;
import com.sjsu.boreas.Misc.ContextHelper;
import com.sjsu.boreas.Misc.FragmentTabAdapter;
import com.sjsu.boreas.MainActivity;
import com.sjsu.boreas.R;
import com.sjsu.boreas.ContactRecyclerItems.UserListAdapter;
import com.sjsu.boreas.OnlineConnectionHandlers.FirebaseController;
import com.sjsu.boreas.ContactRecyclerItems.UserViewHolder;
import com.sjsu.boreas.Database.Contacts.User;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

public class AddContactActivity extends AppCompatActivity {

    private static String TAG = "BOREAS";
    private static String SUB_TAG = "-------ADdContactActivity ";

    private RecyclerView recyclerView;
    private ArrayList<User> userArrayList;
    private RecyclerView.LayoutManager layoutManager;
    private LandingPage mParent;
    private SearchView searchBar;
    private UserListAdapter mAdapter2;
    private ViewPager mViewPager;
    private FragmentTransaction mFragmentTransaction;
    private List<Fragment> mFragments;

    private LocalDatabaseReference localDatabaseReference = LocalDatabaseReference.get();

//    private DatabaseReference database_ref;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        Log.e(TAG, SUB_TAG+"on create");
        super.onCreate(savedInstanceState);
        userArrayList = new ArrayList<User>();
        setContentView(R.layout.activity_add_contact);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP){
            Window window = getWindow();
            window.clearFlags(WindowManager.LayoutParams.FLAG_TRANSLUCENT_STATUS);
            window.addFlags(WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS);
            getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR);
            window.setStatusBarColor(ContextCompat.getColor(ContextHelper.get().getApplicationContext(),R.color.backgroundAlt));
        }

        mFragmentTransaction = getSupportFragmentManager().beginTransaction();
        mFragmentTransaction.replace(R.id.usersList, new OnlineListOfPeopleFragment());
        mFragmentTransaction.commit();
        initViews();
    }

    private void initViews() {
        Log.e(TAG, SUB_TAG+"InitViews");
//        initViewPager();
//        initTabLayout();
    }

    private void initViewPager() {
        mViewPager = (ViewPager) findViewById(R.id.viewpager);
        List<String> tabNames = new ArrayList<String>();
        tabNames.add("Online People List");
        tabNames.add("Offline People List");
        FragmentTabAdapter fragmentTabAdapter = new FragmentTabAdapter(getSupportFragmentManager(), getFragments(), tabNames);
        mViewPager.setOffscreenPageLimit(2);
        mViewPager.setAdapter(fragmentTabAdapter);
    }

//    private void initTabLayout() {
//        TabLayout tabLayout = (TabLayout) findViewById(R.id.tabs);
//        tabLayout.setupWithViewPager(mViewPager);
//        tabLayout.setSelectedTabIndicatorColor(Color.parseColor("#FFFFFF"));
//        tabLayout.getTabAt(0).setIcon(R.drawable.ic_contacts);
//        tabLayout.getTabAt(1).setIcon(R.drawable.ic_contacts);
//    }

    private List<Fragment> getFragments() {

        mFragments = new ArrayList<Fragment>();
        mFragments.add(OnlineListOfPeopleFragment.newInstance(""));
        mFragments.add(OfflinePeopleContactedListFragment.newInstance(""));

        return mFragments;
    }

    public static void addContact(final User user){
        Log.e(TAG, SUB_TAG+"addContact");
        // Online: store contact relationship in Supabase
        FirebaseController.addContact(user);
    }
}
