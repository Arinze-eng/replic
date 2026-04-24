package com.sjsu.boreas;

import androidx.appcompat.app.AppCompatActivity;

import android.graphics.Typeface;
import android.os.AsyncTask;
import android.os.Bundle;
import android.text.method.PasswordTransformationMethod;
import android.util.DisplayMetrics;
import android.util.Log;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;

import com.sjsu.boreas.Database.LocalDatabaseReference;
import com.sjsu.boreas.Database.Contacts.User;
import com.sjsu.boreas.Database.LoggedInUser.LoggedInUser;
import com.sjsu.boreas.OnlineConnectionHandlers.FirebaseController;
import com.sjsu.boreas.Security.PasswordManager;

public class LoginActivity extends AppCompatActivity {

    private static String TAG = "BOREAS";
    private static String SUB_TAG = "--------LoginActivity--- ";

    private EditText userID;
    private EditText password;
    private Button loginButton;
    private TextView signupButton;
    private LinearLayout loginLayout;

    private LocalDatabaseReference localDatabaseReference;

    private LoggedInUser loggedInUser;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_login);

        DisplayMetrics displayMetrics = new DisplayMetrics();
        getWindowManager().getDefaultDisplay().getMetrics(displayMetrics);
        int width = displayMetrics.widthPixels;
        int margin = (width/6);
        loginLayout = (LinearLayout) findViewById(R.id.login_layout);
        ViewGroup.MarginLayoutParams params = (ViewGroup.MarginLayoutParams) loginLayout.getLayoutParams();
        params.setMargins(margin,0,0,0);

        Log.e(TAG, SUB_TAG+"onCreate");

        localDatabaseReference = LocalDatabaseReference.get();
        loggedInUser = null;

        userID = findViewById(R.id.login_userid);
        password = findViewById(R.id.login_password);
        loginButton = findViewById(R.id.login_button);
        signupButton = findViewById(R.id.register_login_act);

        password.setTypeface(Typeface.DEFAULT);
        password.setTransformationMethod(new PasswordTransformationMethod());

        loginButton.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                Log.e(TAG, SUB_TAG+"signup button on click listener");
                tryLoggingIn();
            }
        });

        signupButton.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                Log.e(TAG, SUB_TAG+"clicking on the sign up button");
                MainActivity.context.onActivityResult(0, MainActivity.REGISTER_ACTIVTY_START_CODE, null);
            }
        });
    }

    private void tryLoggingIn(){
        Log.e(TAG, SUB_TAG+"Trying to login");

        String passwordStr = password.getText().toString();
        String userIDStr = userID.getText().toString();

        if(passwordStr.equals("") || userIDStr.equals("")){
            Log.e(TAG, SUB_TAG+"One or both of the fields are empty");
            return;
        }

        String hashedPassword = PasswordManager.hashThePassword(passwordStr);

        checkLocalDatabase(userIDStr, hashedPassword);
    }

    private void checkLocalDatabase(final String userID, final String password){
        Log.e(TAG, SUB_TAG+"checking local database for the user");
        final User user = null;

        AsyncTask.execute(new Runnable() {
            @Override
            public void run() {
                loggedInUser = localDatabaseReference.logUserIn(userID, password);
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        if(loggedInUser != null)
                            success();
                        else
                            checkFirebase(userID, password);
                    }
                });
            }
        });
    }

    private void checkFirebase(String userID, String password){
        Log.e(TAG, SUB_TAG+"Checking firebase");
        loggedInUser = FirebaseController.checkLogInInfo(userID, password, this);
        if(loggedInUser != null) {
            //TODO: gotta replace the currently registered user with this new user from Firebase
            success();
        }else failed();
    }

    private void success(){
        Log.e(TAG, SUB_TAG+"success >>>>>>>>>>>>>>>>>>>> : " + loggedInUser);
        FirebaseController.pushFirebaseToken(loggedInUser);
        MainActivity.context.checkRegistration();
    }

    private void failed(){
        Log.e(TAG, SUB_TAG+"Login failed, please review ur credentials, or try again later.");
    }

}