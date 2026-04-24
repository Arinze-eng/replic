package com.sjsu.boreas.Database.Contacts;

import androidx.room.Dao;
import androidx.room.Delete;
import androidx.room.Insert;
import androidx.room.OnConflictStrategy;
import androidx.room.Query;
import androidx.room.Update;

import java.util.ArrayList;
import java.util.List;

@Dao
public interface UserDao {

    @Query("SELECT * FROM user")
    List<User> getUsers();

    @Query("SELECT * FROM user WHERE uid is :userID")
    List<User> getSpecificUser(String userID);

    @Query("SELECT * FROM user ORDER BY abs((latitude * latitude) + (longitude * longitude) - (:lat * :lat) - (:lon * :lon)) ASC")
    List<User> getClosestUsers(double lat, double lon);

    @Query("DELETE FROM user")
    void clearUserTable();

    @Insert(onConflict = OnConflictStrategy.IGNORE)
    void insertAll(ArrayList<User> users);

    @Insert(onConflict = OnConflictStrategy.IGNORE)
    void insertNewUser(User user);

    @Update
    void updateUser(User user);

    @Delete
    void delete(User user);
}
