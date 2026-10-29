package cn.buwei.nativeapp.features
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
class TaskHierarchyTest {
 private fun row(id:String,parent:String?=null)=buildJsonObject{put("taskId",id);put("title",id);put("parentTaskId",parent?.let(::JsonPrimitive)?:JsonNull)}
 @Test fun filteringKeepsAncestorsEvenWhenCollapsed(){val tasks=listOf(row("root"),row("child","root"),row("leaf","child"),row("other"));val shown=taskTreeRows(tasks,setOf("leaf"),setOf("root"),true);assertEquals(listOf("root","child","leaf"),shown.map{it.task.twText("taskId")});assertEquals(listOf(true,true,false),shown.map{it.context});assertEquals(listOf(0,1,2),shown.map{it.depth})}
 @Test fun collapseDoesNotLeakDescendantsAsRoots(){val tasks=listOf(row("root"),row("child","root"),row("leaf","child"));assertEquals(listOf("root"),taskTreeRows(tasks,setOf("root","child","leaf"),setOf("root"),false).map{it.task.twText("taskId")})}
 @Test fun missingParentIsVisibleAndBrokenCyclesTerminate(){val orphan=row("child","missing");assertEquals("child",taskTreeRows(listOf(orphan),setOf("child"),emptySet(),false).single().task.twText("taskId"));assertEquals(listOf("b"),taskAncestors(row("a","b"),listOf(row("a","b"),row("b","a"))).map{it.twText("taskId")})}
}
