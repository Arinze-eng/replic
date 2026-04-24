package com.sjsu.boreas;

import android.os.AsyncTask;
import android.os.Bundle;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.Toast;

import androidx.appcompat.app.AppCompatActivity;

import com.sjsu.boreas.Database.LocalDatabaseReference;

public class EditProfileActivity extends AppCompatActivity {

    EditText userNameLabel;
    Button update;
    private LocalDatabaseReference localDatabaseReference;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_edit_profile);
        userNameLabel = findViewById(R.id.settings_user_name);
        update = findViewById(R.id.update);
        localDatabaseReference = LocalDatabaseReference.get();
        userNameLabel.setText(LandingPage.currentUser.name);
        update.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                edit();
            }
        });
    }

    /**
     * Edit message
     */
    private void edit() {
        AsyncTask.execute(new Runnable() {
            @Override
            public void run() {
                LandingPage.currentUser.name = userNameLabel.getText().toString();
                localDatabaseReference.updateName(userNameLabel.getText().toString(), LandingPage.currentUser.getUid());
                EditProfileActivity.this.runOnUiThread(new Runnable() {
                    public void run() {
                        Toast.makeText(EditProfileActivity.this, "Updated Successfully", Toast.LENGTH_SHORT).show();
                        EditProfileActivity.super.onBackPressed();
                    }
                });
            }
        });
    }
}