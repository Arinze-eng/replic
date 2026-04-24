package com.sjsu.boreas.OnlineConnectionHandlers;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.NetworkInfo;
import android.util.Log;
import android.widget.Toast;

import com.sjsu.boreas.Database.Contacts.User;
import com.sjsu.boreas.Database.LocalDatabaseReference;
import com.sjsu.boreas.Database.LoggedInUser.LoggedInUser;
import com.sjsu.boreas.Database.Messages.ChatMessage;
import com.sjsu.boreas.MainActivity;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.IOException;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;

import okhttp3.Call;
import okhttp3.Callback;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;

/**
 * Supabase-backed replacement for the original FirebaseController.
 *
 * Implementation notes:
 * - Uses PostgREST (REST API) with a publishable/anon key.
 * - This app keeps its own identity model (uid/password/keys) instead of Supabase Auth.
 * - Tables expected (public): boreas_users, boreas_contacts, boreas_messages
 */
public class FirebaseController {

    private static final String TAG = "BOREAS";
    private static final String SUB_TAG = "-----SupabaseController--- ";

    // Supabase project (from MCP-discovered project)
    private static final String SUPABASE_URL = "https://ljnparociyyggmxdewwv.supabase.co";

    // Legacy anon key (works as an apikey for PostgREST). Consider rotating for production.
    private static final String SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxqbnBhcm9jaXl5Z2dteGRld3d2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY5Njk3MzYsImV4cCI6MjA5MjU0NTczNn0.Lr4UR7llvzC9QxQIwOGdRxn4-2hyRgqYXAnfDRC1-C8";

    private static final MediaType JSON = MediaType.get("application/json; charset=utf-8");

    private static final OkHttpClient http = new OkHttpClient();

    private static LoggedInUser loggedInUser = null;
    private static LocalDatabaseReference localDatabaseReference = LocalDatabaseReference.get();

    // ----------------------------
    // Helpers
    // ----------------------------

    private static Request.Builder baseRequest(String url) {
        return new Request.Builder()
                .url(url)
                .addHeader("apikey", SUPABASE_ANON_KEY)
                // If you later enable RLS and use Auth, you'd also set:
                // .addHeader("Authorization", "Bearer " + accessToken)
                .addHeader("Authorization", "Bearer " + SUPABASE_ANON_KEY)
                .addHeader("Accept", "application/json");
    }

    private static boolean networkIsAvailable(Context context) {
        try {
            ConnectivityManager connectivityManager =
                    (ConnectivityManager) context.getSystemService(Context.CONNECTIVITY_SERVICE);
            NetworkInfo activeNetworkInfo = connectivityManager.getActiveNetworkInfo();
            return activeNetworkInfo != null && activeNetworkInfo.isConnected();
        } catch (Exception e) {
            return false;
        }
    }

    private static void showNetworkErrorMessage(Context context) {
        Toast.makeText(context, "Network not available, can't access online DB.", Toast.LENGTH_SHORT).show();
    }

    private static String enc(String s) {
        try {
            return URLEncoder.encode(s, "UTF-8");
        } catch (Exception e) {
            return s;
        }
    }

    private static String chatId(String uid1, String uid2) {
        if (uid1.compareTo(uid2) <= 0) return uid1 + "_" + uid2;
        return uid2 + "_" + uid1;
    }

    // ----------------------------
    // Users / registration
    // ----------------------------

    public static void pushNewUserToFIrebase(final User myUser, final Context context) {
        // NOTE: method name kept for backwards compatibility.
        Log.e(TAG, SUB_TAG + "Push new user to Supabase");

        if (!networkIsAvailable(context)) {
            showNetworkErrorMessage(context);
            return;
        }

        try {
            JSONObject body = new JSONObject();
            body.put("uid", myUser.uid);
            body.put("name", myUser.name);
            body.put("latitude", myUser.latitude);
            body.put("longitude", myUser.longitude);
            body.put("public_key", myUser.publicKey);

            // If this User is actually a LoggedInUser at registration time, these fields
            // are set via the calling code in RegisterActivity -> it uses LoggedInUser.
            if (myUser instanceof LoggedInUser) {
                LoggedInUser liu = (LoggedInUser) myUser;
                body.put("password", liu.password);
                body.put("private_key", liu.privateKey);
            }

            String url = SUPABASE_URL + "/rest/v1/boreas_users";
            Request req = baseRequest(url)
                    .addHeader("Prefer", "resolution=merge-duplicates")
                    .post(RequestBody.create(body.toString(), JSON))
                    .build();

            http.newCall(req).enqueue(new Callback() {
                @Override
                public void onFailure(Call call, IOException e) {
                    Log.e(TAG, SUB_TAG + "Failed to register user: " + e);
                }

                @Override
                public void onResponse(Call call, Response response) throws IOException {
                    Log.e(TAG, SUB_TAG + "Register user response: " + response.code());
                    response.close();
                }
            });

        } catch (Exception e) {
            Log.e(TAG, SUB_TAG + "Register user exception: " + e);
        }
    }

    // ----------------------------
    // Fetch users (directory)
    // ----------------------------

    public static void fetchAllUsers(final UsersFetchCallback cb){
        try {
            String url = SUPABASE_URL + "/rest/v1/boreas_users?select=uid,name,latitude,longitude,public_key";
            Request req = baseRequest(url).get().build();
            http.newCall(req).enqueue(new Callback() {
                @Override
                public void onFailure(Call call, IOException e) {
                    if(cb!=null) cb.onError(e);
                }

                @Override
                public void onResponse(Call call, Response response) throws IOException {
                    String raw = response.body() != null ? response.body().string() : "[]";
                    response.close();
                    try{
                        JSONArray arr = new JSONArray(raw);
                        ArrayList<User> out = new ArrayList<>();
                        for(int i=0;i<arr.length();i++){
                            JSONObject u = arr.getJSONObject(i);
                            out.add(new User(
                                    u.getString("uid"),
                                    u.getString("name"),
                                    u.optDouble("latitude",0.0),
                                    u.optDouble("longitude",0.0),
                                    u.optString("public_key","")
                            ));
                        }
                        if(cb!=null) cb.onSuccess(out);
                    }catch(Exception e){
                        if(cb!=null) cb.onError(e);
                    }
                }
            });
        }catch(Exception e){
            if(cb!=null) cb.onError(e);
        }
    }

    public interface UsersFetchCallback{
        void onSuccess(ArrayList<User> users);
        void onError(Exception e);
    }

    // ----------------------------
    // Login (app-level)
    // ----------------------------

    public static LoggedInUser checkLogInInfo(final String userID, final String password, final Context context) {
        Log.e(TAG, SUB_TAG + "Checking the provided user ID and password on Supabase");

        if (!networkIsAvailable(context)) {
            showNetworkErrorMessage(context);
            return null;
        }

        try {
            String url = SUPABASE_URL + "/rest/v1/boreas_users?uid=eq." + enc(userID) + "&select=*";
            Request req = baseRequest(url).get().build();

            http.newCall(req).enqueue(new Callback() {
                @Override
                public void onFailure(Call call, IOException e) {
                    Log.e(TAG, SUB_TAG + "Login request failed: " + e);
                }

                @Override
                public void onResponse(Call call, Response response) throws IOException {
                    String raw = response.body() != null ? response.body().string() : "[]";
                    response.close();

                    try {
                        JSONArray arr = new JSONArray(raw);
                        if (arr.length() == 0) {
                            Log.e(TAG, SUB_TAG + "No such user");
                            return;
                        }
                        JSONObject u = arr.getJSONObject(0);
                        String storedPassword = u.optString("password", "");
                        if (!password.equals(storedPassword)) {
                            Log.e(TAG, SUB_TAG + "Wrong password");
                            return;
                        }

                        loggedInUser = new LoggedInUser(
                                u.getString("uid"),
                                u.getString("name"),
                                u.optDouble("latitude", 0.0),
                                u.optDouble("longitude", 0.0),
                                storedPassword,
                                u.optString("public_key", ""),
                                u.optString("private_key", "")
                        );

                        // Mirror original behavior: save locally + mark logged in
                        localDatabaseReference.registerUser(loggedInUser);
                        Log.e(TAG, SUB_TAG + "Login success for " + loggedInUser.getUid());

                    } catch (Exception e) {
                        Log.e(TAG, SUB_TAG + "Login parse error: " + e + " raw=" + raw);
                    }
                }
            });

        } catch (Exception e) {
            Log.e(TAG, SUB_TAG + "Login exception: " + e);
        }

        return loggedInUser; // will likely be null here (async), same as old Firebase behavior
    }

    public static void pushFirebaseToken(final User user){
        // Firebase Cloud Messaging was removed in Supabase migration.
        // Keeping this method as a no-op to avoid breaking older call sites.
        Log.e(TAG, SUB_TAG+"pushFirebaseToken (no-op)");
    }

    // ----------------------------
    // Contacts
    // ----------------------------

    public static void addContact(User user) {
        Log.e(TAG, SUB_TAG + "Adding contact to Supabase");

        try {
            JSONObject body = new JSONObject();
            body.put("owner_uid", MainActivity.currentUser.getUid());
            body.put("contact_uid", user.getUid());

            String url = SUPABASE_URL + "/rest/v1/boreas_contacts";
            Request req = baseRequest(url)
                    .addHeader("Prefer", "resolution=merge-duplicates")
                    .post(RequestBody.create(body.toString(), JSON))
                    .build();

            http.newCall(req).enqueue(new Callback() {
                @Override
                public void onFailure(Call call, IOException e) {
                    Log.e(TAG, SUB_TAG + "addContact failed: " + e);
                }

                @Override
                public void onResponse(Call call, Response response) {
                    Log.e(TAG, SUB_TAG + "addContact response: " + response.code());
                    response.close();
                }
            });

        } catch (Exception e) {
            Log.e(TAG, SUB_TAG + "addContact exception: " + e);
        }
    }

    public static void synchContactsForUser(LoggedInUser user, final Context context) {
        Log.e(TAG, SUB_TAG + "Sync contacts for provided user (Supabase)");

        if (context != null && !networkIsAvailable(context)) {
            showNetworkErrorMessage(context);
            return;
        }

        try {
            // Use FK join via PostgREST: select contact_uid plus the referenced user row
            String select = "contact_uid,contact:boreas_users!boreas_contacts_contact_uid_fkey(uid,name,latitude,longitude,public_key)";
            String url = SUPABASE_URL + "/rest/v1/boreas_contacts?owner_uid=eq." + enc(user.uid) + "&select=" + enc(select);

            Request req = baseRequest(url).get().build();

            http.newCall(req).enqueue(new Callback() {
                @Override
                public void onFailure(Call call, IOException e) {
                    Log.e(TAG, SUB_TAG + "synchContacts failed: " + e);
                }

                @Override
                public void onResponse(Call call, Response response) throws IOException {
                    String raw = response.body() != null ? response.body().string() : "[]";
                    response.close();

                    try {
                        JSONArray arr = new JSONArray(raw);
                        for (int i = 0; i < arr.length(); i++) {
                            JSONObject row = arr.getJSONObject(i);
                            JSONObject c = row.optJSONObject("contact");
                            if (c == null) continue;

                            User contact = new User(
                                    c.getString("uid"),
                                    c.getString("name"),
                                    c.optDouble("latitude", 0.0),
                                    c.optDouble("longitude", 0.0),
                                    c.optString("public_key", "")
                            );
                            localDatabaseReference.addContact(contact);
                        }
                    } catch (Exception e) {
                        Log.e(TAG, SUB_TAG + "synchContacts parse error: " + e + " raw=" + raw);
                    }
                }
            });

        } catch (Exception e) {
            Log.e(TAG, SUB_TAG + "synchContacts exception: " + e);
        }
    }

    // ----------------------------
    // Messages (online mode)
    // ----------------------------

    public static void pushMessageToFirebase(final ChatMessage chatMessage, Context mActivity) {
        // NOTE: method name kept for backwards compatibility.
        Log.e(TAG, SUB_TAG + "Push message to Supabase");

        if (mActivity != null && !networkIsAvailable(mActivity)) {
            showNetworkErrorMessage(mActivity);
            return;
        }

        try {
            JSONObject body = new JSONObject();
            body.put("chat_id", chatId(MainActivity.currentUser.getUid(), chatMessage.recipient.getUid()));
            body.put("sender_uid", MainActivity.currentUser.getUid());
            body.put("receiver_uid", chatMessage.recipient.getUid());
            body.put("mssg_id", chatMessage.mssgId);
            body.put("mssg_text", chatMessage.mssgText);
            body.put("is_encrypted", chatMessage.isEncrypted);
            body.put("contains_img", chatMessage.contains_img);
            body.put("img_data", chatMessage.imgData == null ? "" : chatMessage.imgData);

            String url = SUPABASE_URL + "/rest/v1/boreas_messages";
            Request req = baseRequest(url)
                    .addHeader("Prefer", "resolution=merge-duplicates")
                    .post(RequestBody.create(body.toString(), JSON))
                    .build();

            http.newCall(req).enqueue(new Callback() {
                @Override
                public void onFailure(Call call, IOException e) {
                    Log.e(TAG, SUB_TAG + "pushMessage failed: " + e);
                }

                @Override
                public void onResponse(Call call, Response response) {
                    Log.e(TAG, SUB_TAG + "pushMessage response: " + response.code());
                    response.close();
                }
            });

        } catch (Exception e) {
            Log.e(TAG, SUB_TAG + "pushMessage exception: " + e);
        }
    }

    /**
     * Polling helper: fetch latest messages for a 1:1 chat.
     * (Firebase realtime listeners removed; this is a simple REST poll.)
     */
    public static void fetchLatestMessages(final String otherUserUid, final int limit, final MessageFetchCallback cb) {
        try {
            String cid = chatId(MainActivity.currentUser.getUid(), otherUserUid);
            String url = SUPABASE_URL + "/rest/v1/boreas_messages?chat_id=eq." + enc(cid)
                    + "&select=*"
                    + "&order=created_at.desc"
                    + "&limit=" + limit;

            Request req = baseRequest(url).get().build();
            http.newCall(req).enqueue(new Callback() {
                @Override
                public void onFailure(Call call, IOException e) {
                    if (cb != null) cb.onError(e);
                }

                @Override
                public void onResponse(Call call, Response response) throws IOException {
                    String raw = response.body() != null ? response.body().string() : "[]";
                    response.close();

                    try {
                        JSONArray arr = new JSONArray(raw);
                        ArrayList<ChatMessage> out = new ArrayList<>();
                        for (int i = 0; i < arr.length(); i++) {
                            JSONObject row = arr.getJSONObject(i);

                            // Minimal reconstruction; app primarily uses local DB + UI.
                            ChatMessage cm = new ChatMessage();
                            cm.mssgId = row.optString("mssg_id", "");
                            cm.mssgText = row.optString("mssg_text", "");
                            cm.isEncrypted = row.optBoolean("is_encrypted", false);
                            cm.contains_img = row.optBoolean("contains_img", false);
                            cm.imgData = row.optString("img_data", "");
                            cm.isMyMssg = MainActivity.currentUser.getUid().equals(row.optString("sender_uid", ""));
                            cm.time = System.currentTimeMillis();
                            out.add(cm);
                        }
                        if (cb != null) cb.onSuccess(out);
                    } catch (Exception e) {
                        if (cb != null) cb.onError(e);
                    }
                }
            });
        } catch (Exception e) {
            if (cb != null) cb.onError(e);
        }
    }

    public interface MessageFetchCallback {
        void onSuccess(ArrayList<ChatMessage> messages);

        void onError(Exception e);
    }
}
