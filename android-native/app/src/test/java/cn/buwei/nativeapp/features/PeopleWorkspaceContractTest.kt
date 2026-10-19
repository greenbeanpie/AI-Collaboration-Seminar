package cn.buwei.nativeapp.features

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class PeopleWorkspaceContractTest {
 @Test fun searchUsesOnlyTrimmedCompleteUsername(){assertEquals("/api/v1/profiles/search?username=Exact_User-1",peopleWorkspaceSearchPath(" Exact_User-1 "));assertEquals("/api/v1/profiles/Exact_User-1",peopleWorkspaceDetailPath("Exact_User-1"));assertFalse(peopleWorkspaceSearchPath("Exact_User").contains("q="))}
 @Test fun rejectsFuzzyQueriesAndNonUsernameCharacters(){listOf("ab","nickname with spaces","*user*","名字","user@example.com","user/other","a".repeat(33)).forEach{value->assertThrows(IllegalArgumentException::class.java){peopleWorkspaceSearchPath(value)}}}
 @Test fun onlyReturnedPublicFieldsAreProjected(){val profile=Json.parseToJsonElement("""{"username":"exact","displayName":"Visible","bio":"Public bio","preferredRoles":"","weeklyAvailableHours":12,"email":"private@example.test","aiUseAllowed":true,"visibility":{"major":false}}""").jsonObject;val fields=peopleWorkspacePublicFields(profile);assertEquals(listOf("bio","preferredRoles"),fields.map{it.first});assertFalse(fields.any{it.first in listOf("email","weeklyAvailableHours","aiUseAllowed","visibility","major","specialties")})}
 @Test fun nullPublicFieldsAreNotRendered(){val profile=Json.parseToJsonElement("""{"bio":null,"major":"Visible major"}""").jsonObject;assertEquals(listOf("major"),peopleWorkspacePublicFields(profile).map{it.first})}
}
