package com.sjsu.boreas.Database.NearByUsers;

import androidx.room.Dao;
import androidx.room.Delete;
import androidx.room.Insert;
import androidx.room.OnConflictStrategy;
import androidx.room.Query;
import androidx.room.Update;

import java.util.ArrayList;
import java.util.List;

@Dao
public interface NearByUsersDao {

    @Query("SELECT * FROM NearByUsers")
    List<NearByUsers> getNearByUsers();

    @Query("SELECT * FROM nearByUsers WHERE uid is :nearByUserID")
    List<NearByUsers> getSpecificNearByUser(String nearByUserID);

    @Query("SELECT * FROM nearByUsers ORDER BY abs((latitude * latitude) + (longitude * longitude) - (:lat * :lat) - (:lon * :lon)) ASC")
    List<NearByUsers> getClosestNearByUsers(double lat, double lon);

    @Query("DELETE FROM nearByUsers")
    void clearNearByUserTable();

    @Insert(onConflict = OnConflictStrategy.IGNORE)
    void insertAll(ArrayList<NearByUsers> nearByUsers);

    @Insert(onConflict = OnConflictStrategy.IGNORE)
    void insertNewNearByUser(NearByUsers nearByUser);

    @Update
    void updateNearByUser(NearByUsers nearByUser);

    @Delete
    void delete(NearByUsers nearByUser);
}
