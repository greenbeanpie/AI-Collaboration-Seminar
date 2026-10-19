package cn.buwei.nativeapp.data;

import androidx.annotation.NonNull;
import androidx.room.*;
import java.util.List;

@Database(entities={NativeDatabase.Snapshot.class, NativeDatabase.Operation.class}, version=1, exportSchema=false)
public abstract class NativeDatabase extends RoomDatabase {
    public abstract Store store();
    @Entity(tableName="snapshots", primaryKeys={"account","path"})
    public static class Snapshot {
        @NonNull public String account="";
        @NonNull public String path="";
        @NonNull public String body="{}";
        public long savedAt;
    }
    @Entity(tableName="operations")
    public static class Operation {
        @PrimaryKey @NonNull public String id="";
        @NonNull public String account="";
        @NonNull public String project="";
        @NonNull public String path="";
        @NonNull public String method="";
        @NonNull public String body="{}";
        @NonNull public String state="pending";
        @NonNull public String reason="";
        public long createdAt;
    }
    @Dao public interface Store {
        @Query("SELECT * FROM snapshots WHERE account=:account AND path=:path") Snapshot snapshot(String account,String path);
        @Insert(onConflict=OnConflictStrategy.REPLACE) void putSnapshot(Snapshot row);
        @Insert(onConflict=OnConflictStrategy.ABORT) void addOperation(Operation row);
        @Query("SELECT * FROM operations WHERE account=:account AND id=:id") Operation operation(String account,String id);
        @Update void updateOperation(Operation row);
        @Query("SELECT * FROM operations WHERE account=:account ORDER BY createdAt,id") List<Operation> operations(String account);
        @Query("DELETE FROM operations WHERE id=:id AND account=:account") void removeOperation(String id,String account);
        @Query("DELETE FROM snapshots WHERE account=:account AND (path=:root OR path LIKE :prefix)") void revokeSnapshots(String account,String root,String prefix);
    }
}
