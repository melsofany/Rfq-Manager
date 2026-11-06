package com.cortoba.fieldops.data.local

import android.content.Context
import androidx.room.Room
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.android.qualifiers.ApplicationContext
import dagger.hilt.components.SingletonComponent
import javax.inject.Singleton

@Module
@InstallIn(SingletonComponent::class)
object DatabaseModule {

    @Provides
    @Singleton
    fun provideDatabase(@ApplicationContext context: Context): FieldOpsDatabase =
        Room.databaseBuilder(context, FieldOpsDatabase::class.java, "cortoba_field_ops.db")
            // The cache is a projection of server state, so a schema change can
            // safely discard it; the outbox is NOT in this path (a destructive
            // migration would drop queued offline work, so migrations are
            // required the moment the outbox shape changes).
            .fallbackToDestructiveMigration()
            .build()

    @Provides
    fun provideDao(database: FieldOpsDatabase): FieldOpsDao = database.dao()
}
