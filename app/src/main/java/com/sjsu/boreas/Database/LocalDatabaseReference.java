package com.sjsu.boreas.Database;

import android.content.Context;
import android.os.AsyncTask;
import android.util.Log;

import androidx.room.Room;

import com.sjsu.boreas.ChatView.MediaFilesRecyclerItems.FileItem;
import com.sjsu.boreas.Database.LoggedInUser.LoggedInUser;
import com.sjsu.boreas.Database.Messages.ChatMessage;
import com.sjsu.boreas.Database.NearByUsers.NearByUsers;
import com.sjsu.boreas.Database.PotentialContacts.PotentialContacts;
import com.sjsu.boreas.Database.Contacts.User;
import com.sjsu.boreas.Events.Event;
import com.sjsu.boreas.Events.EventEmitter;
import com.sjsu.boreas.Messages.LongDistanceMessage;
import com.sjsu.boreas.Notifications.CustomNotification;
import com.sjsu.boreas.OnlineConnectionHandlers.FirebaseController;
import com.sjsu.boreas.Security.EncryptionController;

import java.util.HashMap;
import java.util.List;

public class LocalDatabaseReference implements EventEmitter{

    private Event event_chatmessage = Event.get(Event.CHAT_MSSG);
    private Event event_user = Event.get(Event.USER_ADDED);
    private Event event_user_removed = Event.get(Event.USER_REMOVED);

    private static String TAG = "BOREAS";
    private static String SUB_TAG = "------DatabaseReference----- ";

    private static LocalDatabaseReference localDatabaseReference = null;
    private AppDatabase database;
    private Context appContext = null;

    private CustomNotification customNotification = CustomNotification.get();

    public static LocalDatabaseReference initialize(Context context){
        Log.e(TAG, SUB_TAG+"getting instance");
        if(localDatabaseReference == null){
            localDatabaseReference = new LocalDatabaseReference(context);
            return localDatabaseReference;
        }else {
            return localDatabaseReference;
        }
    }

    private LocalDatabaseReference(Context context){
        Log.e(TAG, SUB_TAG+"Constructor");
        database = Room.databaseBuilder(context, AppDatabase.class, "mydatabase").build();
    }

    public static LocalDatabaseReference get(){
        Log.e(TAG, SUB_TAG+"getting the instance");
        return localDatabaseReference;
    }

    public void saveChatMessageLocally(final ChatMessage message){
        Log.e(TAG, SUB_TAG+"saving chat message locally");

        AsyncTask.execute(new Runnable() {
            @Override
            public void run() {
                if(!isMessageAlreadyInDatabase(message)) {
                    //Before saving the message we have to check if there is any image data in the message
                    if(message.imgData != null && !(message.imgData.isEmpty())){
                        Log.e(TAG, SUB_TAG+"There is image data");
                        String uri = FileItem.saveImageAndGetUri(message);
                    }
                    //message will be encrypted if incoming, plain text if outgoing. but we always save plain text
                    Log.e(TAG, SUB_TAG+"isencrypted? " + message.isEncrypted + "\n" + message.mssgText);
                    ChatMessage temp = message.isEncrypted ? EncryptionController.getInstance().getDecryptedMessage(message) :
                            message;
                    database.chatMessageDao().insertAll(temp);
                    HashMap<String, Object> cm_map = (HashMap<String, Object>) temp.toMap();
                    if(!(temp.isMyMssg)) {
                        customNotification.sendMssgRecvdNotification(temp);
                    }
                    event_chatmessage.trigger(cm_map);
                }
            }
        });

    }

    public void registerUser(final LoggedInUser user){
        Log.e(TAG, SUB_TAG+"save users locally");
        AsyncTask.execute(new Runnable() {
            @Override
            public void run() {
                Log.e(TAG, SUB_TAG+"Adding user to database" + user);
                //Delete the previous registered user (if there is one)
                if(userAlreadyIsRegistered(user)){
                    Log.e(TAG, SUB_TAG+"User is already registered");
                    return;
                }
                wipeAllPreviousUserData();
                Log.e(TAG, SUB_TAG+"Returned from register-----------------");
                database.loggedInUserDao().insertNewUser(user);
                FirebaseController.synchContactsForUser(user, null);
                user.logUserIn();
                Log.e(TAG, SUB_TAG+"-----Just changed the state to login---------"+user);
                database.loggedInUserDao().logUserIn(user);
            }
        });
    }

    //Check if the given user is already registered or not
    private boolean userAlreadyIsRegistered(LoggedInUser user){
        Log.e(TAG, SUB_TAG+"check if user is already registered");

        List<LoggedInUser> allUsers = database.loggedInUserDao().getAllRegisteredUser();

        Log.e(TAG, SUB_TAG+"\n\t\tThese are all the registered users on the device: " + allUsers);

        LoggedInUser previousUser = null;
        previousUser = database.loggedInUserDao().checkIfUserIsAlreadyRegistered(user.getUid());

        if(previousUser != null){
            Log.e(TAG, SUB_TAG+"The user with the provided id is already registered");
            return true;
        }

        return false;
    }

    public User getUserById(String id){
        List<User> users = database.userDao().getSpecificUser(id);
        if(users.size() > 0) {
            Log.e(TAG, SUB_TAG+"\tFound user");
            return users.get(0);
        }
        Log.e(TAG, SUB_TAG+"\tDidn't find a user with that id");
        return null;
    }

    //This function at the moment needs to be called inside a Async thread (a sperate thread)
    public List<ChatMessage> getLastTwentyMessagesForSpecificUser(User specificUser){
        Log.e(TAG, SUB_TAG+"get last 20 mssgs for a specific user");
        return database.chatMessageDao().getLastTwentyMessagesForUser(specificUser.getUid(),
                ChatMessage.ChatTypes.ONEONONEONLINECHAT.getValue());
    }

    //This function at the moment needs to be called inside a Async thread (a sperate thread)
    // like the way its being used in MainActivity
    public LoggedInUser getRegisteredUser(){
        Log.e(TAG, SUB_TAG+"getting the user of this app");
        LoggedInUser user = null;
        user = database.loggedInUserDao().getRegisteredUser();
        Log.e(TAG, SUB_TAG+".................>This is the user: " + user + "<...................");
        return user;
    }

    //The functions below gets the logged in user
    public LoggedInUser getLoggedInUser(){
        Log.e(TAG, SUB_TAG+"Get the logged in user");
        LoggedInUser loggedInUsers = null;
        loggedInUsers = database.loggedInUserDao().getLoggedInUser();
        return loggedInUsers;
    }

    public LoggedInUser logUserIn(String userID, String password){
        Log.e(TAG, SUB_TAG+"Login");
        LoggedInUser user = null;

        user = database.loggedInUserDao().getUserWithGivenCredentials(userID, password);
        if(user != null){
            Log.e(TAG, SUB_TAG+"The provided credentials are correct");
            user.logUserIn();
            Log.e(TAG, SUB_TAG+"--------------"+user);
            database.loggedInUserDao().logUserIn(user);
            return user;
        }
        return null;
    }

    public void logUserOut(LoggedInUser user){
        Log.e(TAG, SUB_TAG+"Loggin user out");
        user.logUserOut();
        database.loggedInUserDao().logUserOut(user);
    }

    public void updateName(String user, String uid){
        Log.e(TAG, SUB_TAG+"Loggin user out");
        database.loggedInUserDao().updateName(user, uid);
    }

    public List<User> getContacts(){
        Log.e(TAG, SUB_TAG+"get contacts");
        return database.userDao().getUsers();
    }

    public void addContact(final User user){
        Log.e(TAG, SUB_TAG+"Saving contact locally");
        AsyncTask.execute(new Runnable() {
            @Override
            public void run() {
                if (!isUserAlreadyInContacts(user)) {
                    Log.e(TAG, SUB_TAG + "User doesn't already exist in the contacts and is being added now");
                    database.userDao().insertNewUser(user);
                    HashMap<String, Object> contact_map = (HashMap<String, Object>) user.toMap();
                    event_user.trigger(contact_map);
                }
            }
        });
    }

    public boolean isUserAlreadyInContacts(User user){
        Log.e(TAG, SUB_TAG+"Checking if user is already in contacts");
        if(!database.userDao().getSpecificUser(user.getUid()).isEmpty()){
            Log.e(TAG, SUB_TAG+"User is already in contacts");
            return true;
        }
        return false;
    }


    public List<PotentialContacts> getPotentialContacts(){
        Log.e(TAG, SUB_TAG+"get potential contacts");
        return database.potentialContactsDao().getUsers();
    }

    public void addPotentialContact(final PotentialContacts user){
        Log.e(TAG, SUB_TAG+"Saving the given user to the potential contact table");
        AsyncTask.execute(new Runnable() {
            @Override
            public void run() {
                if (!isUserAlreadyInPotentialContacts(user)) {
                    Log.e(TAG, SUB_TAG + "------User doesn't already exist in the potential contacts and is being added now");
                    database.potentialContactsDao().insertAll(user);
                }
            }
        });
    }

    public boolean isUserAlreadyInPotentialContacts(PotentialContacts user){
        Log.e(TAG, SUB_TAG+"Checking if user is already in potential contacts");
        if(!database.potentialContactsDao().getSpecificUser(user.getUid()).isEmpty()){
            return true;
        }
        return false;
    }

    public void removePotentialContact(final PotentialContacts potentialContact){
        Log.e(TAG, SUB_TAG+"removing potential contact");
        AsyncTask.execute(new Runnable() {
            @Override
            public void run() {
                database.potentialContactsDao().delete(potentialContact);
                HashMap<String, Object> potential_contact_map = (HashMap<String, Object>) potentialContact.toMap();
                event_user_removed.trigger(potential_contact_map);
            }
        });
    }

    public void convertPotentialContactToContact(final PotentialContacts potentialContact){
        Log.e(TAG, SUB_TAG+"Convert potential contact to contact");

        AsyncTask.execute(new Runnable() {
            @Override
            public void run() {
                //First remove the potential contact
                database.potentialContactsDao().delete(potentialContact);
                HashMap<String, Object> potential_contact_map = (HashMap<String, Object>) potentialContact.toMap();
                event_user_removed.trigger(potential_contact_map);

                //Then add the contact
                User contact = new User(potentialContact.uid, potentialContact.name,
                        potentialContact.latitude, potentialContact.longitude, potentialContact.publicKey);
                localDatabaseReference.database.userDao().insertNewUser(contact);
                HashMap<String, Object> contact_map = (HashMap<String, Object>) contact.toMap();
                event_user.trigger(contact_map);
            }
        });

    }

    public void updateContactItem(final User user){
        Log.e(TAG, SUB_TAG+"Set new message to false");

        AsyncTask.execute(new Runnable() {
            @Override
            public void run() {
                if(user instanceof PotentialContacts) {
                    Log.e(TAG, SUB_TAG + "Updating potential contact: " + user.name);
                    database.potentialContactsDao().updatePotentialContact((PotentialContacts) user);
                }
                else if(user instanceof User) {
                    Log.e(TAG, SUB_TAG + "Updating contact: " + user.name);
                    database.userDao().updateUser(user);
                }
            }
        });

    }

    public boolean isMessageAlreadyInDatabase(ChatMessage mssg){
        Log.e(TAG, SUB_TAG+"Checking if the message is already in database");
        if(!database.chatMessageDao().getSpecificMessage(mssg.mssgId).isEmpty()){
            return true;
        }
        return false;
    }

    public List<User> getAllUsers(){
        Log.e(TAG, SUB_TAG+"Get all the users in the database");
        return database.userDao().getUsers();
    }

    public List<User> getClosestUsers(LongDistanceMessage message){
        Log.e(TAG, SUB_TAG+"get the closest users based on location");
        return database.userDao().getClosestUsers(message.recipient.latitude, message.recipient.longitude);
    }

    public void addNearByUser(final NearByUsers nearByUser){
        Log.e(TAG, SUB_TAG+"Adding a nearby user");
        AsyncTask.execute(new Runnable() {
            @Override
            public void run() {
                if (!isNearByUserAlreadyAdded(nearByUser)) {
                    Log.e(TAG, SUB_TAG + "Nearby User doesn't already exist in the contacts and is being added now");
                    database.nearByUsersDao().insertNewNearByUser(nearByUser);
//                    HashMap<String, Object> contact_map = (HashMap<String, Object>) nearByUser.toMap();
//                    event_user.trigger(contact_map);
                }
            }
        });
    }

    private boolean isNearByUserAlreadyAdded(NearByUsers nearByUser){
        Log.e(TAG, SUB_TAG+"Is near by user already added");
        if(!database.nearByUsersDao().getSpecificNearByUser(nearByUser.getUid()).isEmpty()){
            Log.e(TAG, SUB_TAG+"Near by user is already saved");
            return true;
        }
        return false;
    }

    public NearByUsers getNearByUserBasedOnId(String id){
        Log.e(TAG, SUB_TAG+"getting near by user based on id");
        List<NearByUsers> nearByUsers = database.nearByUsersDao().getSpecificNearByUser(id);
        if(nearByUsers.size() > 0) {
            Log.e(TAG, SUB_TAG+"\tFound user");
            return nearByUsers.get(0);
        }
        Log.e(TAG, SUB_TAG+"\tDidn't find a user with that id");
        return null;
    }

    public List<NearByUsers> getClosestNearbyUsers(LongDistanceMessage message) {
        Log.e(TAG, SUB_TAG + "Getting the closest nearby users based on location");
        return database.nearByUsersDao().getClosestNearByUsers(message.recipient.latitude, message.recipient.longitude);
    }

    public List<User> getClosestUsers(User recipient){
        return database.userDao().getClosestUsers(recipient.getLatitude(), recipient.getLongitude());
    }

    public List<NearByUsers> getClosestNearByUsers(NearByUsers recipient){
        return database.nearByUsersDao().getClosestNearByUsers(recipient.getLatitude(), recipient.getLongitude());
    }

    public void wipeAllPreviousUserData(){
        Log.e(TAG, SUB_TAG+"Wiping the contacts/users table");
//        AsyncTask.execute(new Runnable() {
//            @Override
//            public void run() {
//                database.userDao().clearUserTable();
//                database.potentialContactsDao().clearPotentialContactsTable();
//                database.chatMessageDao().clearAllMessages();
//                database.loggedInUserDao().clearLoggedInUserTable();
//            }
//        });
        database.userDao().clearUserTable();
        database.potentialContactsDao().clearPotentialContactsTable();
        database.chatMessageDao().clearAllMessages();
        database.loggedInUserDao().clearLoggedInUserTable();
        database.nearByUsersDao().clearNearByUserTable();
    }
}
