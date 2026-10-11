package com.heaplens.ai;

import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class ReviewedProposalTest {
    final ReviewedProposal proposal=new ReviewedProposal("original", "proposed");
    @Test void onlyExplicitReviewedTextCanPassWithSameLiveWritableSource() {
        assertDoesNotThrow(()->proposal.check("original","partly reviewed",true,true,true));
        assertDoesNotThrow(()->proposal.check("original","original",true,true,true));
    }
    @Test void editsIncludingUnsavedEditsCannotBeOverwritten() {
        assertThrows(IllegalStateException.class,()->proposal.check("user edit","proposed",true,true,true));
    }
    @Test void replacedMovedDeletedOrReboundDocumentsCannotBeWritten() {
        assertThrows(IllegalStateException.class,()->proposal.check("original","proposed",true,false,true));
    }
    @Test void librariesReadOnlyAndOutOfProjectFilesCannotBeWritten() {
        assertThrows(IllegalStateException.class,()->proposal.check("original","proposed",true,true,false));
    }
    @Test void retryCloseAndUnavailableAnalysisExpireProposal() {
        assertThrows(IllegalStateException.class,()->proposal.check("original","proposed",false,true,true));
    }
    @Test void reviewAndProviderTextStayBounded() {
        assertThrows(IllegalStateException.class,()->proposal.check("original",null,true,true,true));
        assertThrows(IllegalStateException.class,()->proposal.check("original","x".repeat(ReviewedProposal.MAX_CHARS+1),true,true,true));
        assertThrows(IllegalArgumentException.class,()->new ReviewedProposal("original","x".repeat(ReviewedProposal.MAX_CHARS+1)));
    }
}
